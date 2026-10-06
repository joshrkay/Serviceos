/**
 * #1601 step 2 — the ANSWER to a question asked at the `intent_confirm`
 * readback (#1476 item 3) has ONE home; each surface keeps only its ports.
 *
 * The processor and the in-app adapter each carried the same ~60 lines and
 * had already drifted on cost-cap handling. The rule (the processor's):
 *   - "what number do you have for me?" — an UNTRUSTED (S1) caller hears
 *     only what they gave on this call or their own caller-ID masked, never
 *     a number off a customer record (the record is not even read); a
 *     trusted surface may read the number on file;
 *   - a question about the pending request's own details (time, captured
 *     price) is answered from its slots — no classify, no lookup;
 *   - anything else goes through the surface's read-only lookup path: the
 *     unchanged classifier names the lookup, and only a CONFIDENT lookup
 *     intent is answered — a mutation intent, low confidence, a classifier
 *     failure, or a surface that serves no lookups says "I don't have that
 *     detail yet"; a question never becomes an instruction;
 *   - a lookup classify that crosses the session cost cap supersedes the
 *     answer (the surface escalates).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  answerConfirmTurnQuestion,
  type ConfirmTurnLookupPorts,
} from '../../../../src/ai/voice-turn/shared/confirm-turn-answer';
import { VoiceSessionStore } from '../../../../src/ai/agents/customer-calling/voice-session-store';
import { TTS_COPY } from '../../../../src/ai/agents/customer-calling/tts-copy';
import { TAU_INT } from '../../../../src/ai/agents/customer-calling/transitions';
import type { IntentClassification } from '../../../../src/ai/orchestration/intent-classifier';

const TENANT = 't-1601-confirm';
const store = new VoiceSessionStore({ startInterval: false });

function pending(entities: Record<string, unknown>) {
  const s = store.create(TENANT, 'telephony', { callSid: `CA-${Math.random().toString(36).slice(2, 8)}` });
  s.machine.dispatch({ type: 'incoming_call', tenantId: TENANT, callSid: s.callSid!, from: '+15125550100', to: '+15125550000' });
  s.machine.dispatch({ type: 'greeted_ok' });
  s.machine.dispatch({ type: 'caller_known', customerId: 'cust-1' });
  s.machine.dispatch({ type: 'intent_classified', intentType: 'create_appointment', confidence: 0.95, entities });
  return s;
}

const classification = (intentType: string, confidence = 0.95): IntentClassification =>
  ({ intentType, confidence, extractedEntities: {}, tokenUsage: { input: 1, output: 1 } }) as unknown as IntentClassification;

function lookupPorts(overrides: Partial<ConfirmTurnLookupPorts> = {}) {
  const ports: ConfirmTurnLookupPorts = {
    classify: vi.fn(async () => classification('lookup_jobs')),
    recordCost: vi.fn(() => false),
    answer: vi.fn(async () => 'Two jobs tomorrow.'),
    ...overrides,
  };
  return ports;
}

describe('answerConfirmTurnQuestion (shared)', () => {
  it('callback number, S1 caller: the number they gave this call, else their caller-ID masked — the record is never read', async () => {
    const findById = vi.fn(async () => ({ primaryPhone: '+14805550199' }));
    const gave = await answerConfirmTurnQuestion(pending({ phone: '+15125550123' }), 'callback_number', 'what number do you have', {
      untrustedCaller: true, callerId: '+15125550100', customerRepo: { findById } as never, lookup: null,
    });
    expect(gave).toEqual({ capExceeded: false, answer: 'The callback number I have is 512-555-0123.' });
    const masked = await answerConfirmTurnQuestion(pending({ customerId: 'cust-1' }), 'callback_number', 'what number do you have', {
      untrustedCaller: true, callerId: '+15125550100', customerRepo: { findById } as never, lookup: null,
    });
    expect(masked).toEqual({ capExceeded: false, answer: "I'd call you back at the number you're calling from, ending in 0100." });
    expect(findById).not.toHaveBeenCalled();
  });

  it('callback number, trusted surface: reads the number on file for the pending customer', async () => {
    const findById = vi.fn(async () => ({ primaryPhone: '+14805550199' }));
    const s = pending({ customerId: 'cust-1' });
    const out = await answerConfirmTurnQuestion(s, 'callback_number', 'what number do you have', {
      untrustedCaller: false, customerRepo: { findById } as never, lookup: null,
    });
    expect(out).toEqual({ capExceeded: false, answer: 'The number on file is 480-555-0199.' });
    expect(findById).toHaveBeenCalledWith(TENANT, 'cust-1');
  });

  it('a question about the pending request is answered from its slots — no classify', async () => {
    const lookup = lookupPorts();
    const out = await answerConfirmTurnQuestion(pending({ dateTimeDescription: 'Tuesday at 2pm' }), 'time', 'what time was that', {
      untrustedCaller: true, lookup,
    });
    expect(out).toEqual({ capExceeded: false, answer: 'I have it down for Tuesday at 2pm.' });
    expect(lookup.classify).not.toHaveBeenCalled();
  });

  it('any other question goes through the lookup port when the classifier names a confident lookup', async () => {
    const lookup = lookupPorts();
    const out = await answerConfirmTurnQuestion(pending({}), 'other', 'what do I have tomorrow', { untrustedCaller: false, lookup });
    expect(out).toEqual({ capExceeded: false, answer: 'Two jobs tomorrow.' });
    expect(lookup.recordCost).toHaveBeenCalledTimes(1);
  });

  it('a non-lookup intent, low confidence, a classifier failure, or no lookup port: "no detail yet" — never an instruction', async () => {
    const q = (lookup: ConfirmTurnLookupPorts | null) =>
      answerConfirmTurnQuestion(pending({}), 'other', 'can you cancel it', { untrustedCaller: false, lookup });
    const mutation = lookupPorts({ classify: vi.fn(async () => classification('cancel_appointment')) });
    expect(await q(mutation)).toEqual({ capExceeded: false, answer: TTS_COPY.no_detail_yet.en });
    expect(mutation.answer).not.toHaveBeenCalled();
    const low = lookupPorts({ classify: vi.fn(async () => classification('lookup_jobs', TAU_INT - 0.01)) });
    expect(await q(low)).toEqual({ capExceeded: false, answer: TTS_COPY.no_detail_yet.en });
    const onClassifyError = vi.fn();
    const broken = lookupPorts({ classify: vi.fn(async () => { throw new Error('gateway down'); }), onClassifyError });
    expect(await q(broken)).toEqual({ capExceeded: false, answer: TTS_COPY.no_detail_yet.en });
    expect(onClassifyError).toHaveBeenCalledTimes(1);
    expect(await q(null)).toEqual({ capExceeded: false, answer: TTS_COPY.no_detail_yet.en });
  });

  it('a lookup classify that crosses the session cap supersedes the answer', async () => {
    const lookup = lookupPorts({ recordCost: vi.fn(() => true) });
    const out = await answerConfirmTurnQuestion(pending({}), 'other', 'what do I have tomorrow', { untrustedCaller: false, lookup });
    expect(out).toEqual({ capExceeded: true });
    expect(lookup.answer).not.toHaveBeenCalled();
  });
});
