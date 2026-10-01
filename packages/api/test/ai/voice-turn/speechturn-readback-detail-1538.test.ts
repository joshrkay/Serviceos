/**
 * #1538 — the phone turn engine (createVoiceTurnProcessor().speechTurn,
 * behind media streams): a caller who answers the `intent_confirm` readback
 * with a missing DETAIL ("Tuesday at 2pm") instead of yes/no must not lose
 * the request. The detail is merged into the pending request and the
 * readback is spoken again — in-app parity (D01 / Train-7). An explicit
 * "no", or a clearly different request, still corrects.
 *
 * Seam: speechTurn with a scripted gateway (classifier + confirm_intent) and
 * in-memory repos — the #1476 speechTurn harness.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { createVoiceTurnProcessor } from '../../../src/ai/voice-turn';
import { VoiceSessionStore } from '../../../src/ai/agents/customer-calling/voice-session-store';
import { InMemoryAuditRepository } from '../../../src/audit/audit';
import { InMemoryProposalRepository } from '../../../src/proposals/proposal';
import { InMemoryCustomerRepository, createCustomer } from '../../../src/customers/customer';
import type { LLMGateway, LLMRequest } from '../../../src/ai/gateway/gateway';
import type { SideEffect } from '../../../src/ai/agents/customer-calling/types';

const TENANT = 'tenant-1538-phone';
const CALL_SID = 'CA-1538';
const CALLER_ID = '+15125550100';

/** The bare time fragment the caller answers the readback with. */
const TIME_ONLY = JSON.stringify({
  intentType: 'unknown',
  confidence: 0.4,
  extractedEntities: { dateTimeDescription: 'Tuesday at 2pm' },
});
const DIFFERENT_REQUEST = JSON.stringify({
  intentType: 'send_invoice',
  confidence: 0.93,
  extractedEntities: { customerName: 'Henderson' },
});

/**
 * The classifier answers by what the caller said (turn 1, "book a service
 * appointment", never reaches the model: the classifier's deterministic
 * booking rule answers it). confirm_intent says "yes" only to "Yes, that's
 * right" — a detail is not a yes, which is exactly why it used to become a
 * correction.
 */
function phoneGateway(byUtterance: Record<string, string>): LLMGateway {
  return {
    complete: vi.fn(async (req: LLMRequest) => {
      const isConfirm =
        (req.metadata as { skill?: string } | undefined)?.skill === 'confirm_intent';
      const said = JSON.stringify(req.messages ?? '');
      const saidYes = /Yes, that's right/.test(said);
      const scripted = Object.entries(byUtterance).find(([utterance]) => said.includes(utterance));
      return {
        content: isConfirm
          ? JSON.stringify({ answer: saidYes ? 'yes' : 'no', reasoning: 'scripted' })
          : (scripted?.[1] ?? JSON.stringify({ intentType: 'unknown', confidence: 0.2, extractedEntities: {} })),
        model: 'mock',
        provider: 'mock',
        tokenUsage: { input: 1, output: 1, total: 2 },
        latencyMs: 1,
      };
    }),
  } as unknown as LLMGateway;
}

const stores: VoiceSessionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

async function makeCall(byUtterance: Record<string, string> = {}) {
  const store = new VoiceSessionStore({ startInterval: false });
  stores.push(store);
  const proposalRepo = new InMemoryProposalRepository();
  const customerRepo = new InMemoryCustomerRepository();
  const customer = await createCustomer(
    {
      tenantId: TENANT,
      firstName: 'Dana',
      lastName: 'Reyes',
      primaryPhone: '+14805550199',
      createdBy: 'test',
    },
    customerRepo,
  );
  const session = store.create(TENANT, 'telephony', { callSid: CALL_SID });
  session.machine.dispatch({
    type: 'incoming_call',
    callSid: CALL_SID,
    from: CALLER_ID,
    to: '+15125550999',
    tenantId: TENANT,
  });
  session.machine.dispatch({ type: 'greeted_ok' });
  session.machine.dispatch({ type: 'caller_known', customerId: customer.id });
  session.customerId = customer.id;
  session.callerPhone = CALLER_ID;
  const processor = createVoiceTurnProcessor({
    store,
    gateway: phoneGateway(byUtterance),
    businessName: 'Acme Plumbing',
    systemActorId: 'test-actor',
    auditRepo: new InMemoryAuditRepository(),
    proposalRepo,
    customerRepo,
  });
  const turn = (speechResult: string) =>
    processor.speechTurn({ session, speechResult, callSid: CALL_SID, tenantId: TENANT });
  return { session, proposalRepo, turn };
}

function spoken(sideEffects: SideEffect[]): string {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => String(fx.payload.text))
    .join(' ');
}

describe('#1538 — phone: a detail given at the readback', () => {
  it('merges the detail into the pending booking, reads back again, and the yes drafts it', async () => {
    const { session, proposalRepo, turn } = await makeCall({ 'Tuesday at 2pm': TIME_ONLY });
    await turn('I want to book a service appointment.');
    expect(session.machine.currentState).toBe('intent_confirm');

    const reply = spoken(await turn('Tuesday at 2pm.'));
    expect(session.machine.currentState).toBe('intent_confirm');
    expect(reply).not.toMatch(/let me try again/i);
    expect(reply).toMatch(/Is that right\?/);
    expect(session.machine.currentContext.currentIntent).toBe('create_appointment');
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe(
      'Tuesday at 2pm',
    );

    await turn("Yes, that's right.");
    const proposals = await proposalRepo.findByTenant(TENANT);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalType).toBe('create_appointment');
  });

  // #1331 — Layer 2 run 36895893912 (two-step-booking, all 3 runs): the live
  // classifier named no intent AND extracted no slot from the bare answer
  // "Tuesday at 2pm.", so nothing merged and the caller heard the same
  // "…with no day or time yet. Is that right?" again; the yes then drafted a
  // booking with no time. A booking still missing its WHEN, answered with a
  // phrase that IS a day/time, takes that phrase as the time.
  it('takes a bare day/time answer as the booking time even when the classifier extracted nothing', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const { session, proposalRepo, turn } = await makeCall({ 'Tuesday at 2pm': NOTHING });
    await turn('I want to book a service appointment.');

    const reply = spoken(await turn('Tuesday at 2pm.'));
    expect(reply).toBe("Just to confirm — you'd like to schedule an appointment, Tuesday at 2pm. Is that right?");
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBe('Tuesday at 2pm');

    await turn("Yes, that's right.");
    expect((await proposalRepo.findByTenant(TENANT)).map((p) => p.proposalType)).toEqual(['create_appointment']);
  });

  it('an answer that is not a day/time still merges nothing (the readback is re-asked unchanged)', async () => {
    const NOTHING = JSON.stringify({ intentType: 'unknown', confidence: 0.3, extractedEntities: {} });
    const { session, turn } = await makeCall({ 'whatever works': NOTHING });
    await turn('I want to book a service appointment.');
    const reply = spoken(await turn('Hmm, whatever works for you.'));
    expect(reply).toMatch(/with no day or time yet/);
    expect(session.machine.currentContext.extractedEntities?.dateTimeDescription).toBeUndefined();
  });
});

describe('#1538 — phone: a real correction at the readback still corrects', () => {
  it('an explicit "no" drops the pending request', async () => {
    const { session, proposalRepo, turn } = await makeCall();
    await turn('I want to book a service appointment.');
    expect(session.machine.currentState).toBe('intent_confirm');

    await turn("No, that's wrong.");
    expect(session.machine.currentState).toBe('intent_capture');
    expect(session.machine.currentContext.currentIntent).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });

  it('a different request is a correction, never folded into the booking', async () => {
    const { session, proposalRepo, turn } = await makeCall({
      'send the Henderson invoice': DIFFERENT_REQUEST,
    });
    await turn('I want to book a service appointment.');

    await turn('Actually, send the Henderson invoice.');
    expect(session.machine.currentState).toBe('intent_capture');
    expect(session.machine.currentContext.extractedEntities?.customerName).toBeUndefined();
    expect(await proposalRepo.findByTenant(TENANT)).toHaveLength(0);
  });
});
