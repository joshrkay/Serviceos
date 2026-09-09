/**
 * R1 instrumentation — `deriveTurnTrace` is the pure function that answers
 * "how far did this turn get, and what stopped it?". Everything the in-app
 * adapter feeds it is a plain description of the turn, so the precedence
 * rules can be pinned here without a session, a gateway, or an FSM.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveTurnTrace,
  normalizeTurnText,
} from '../../../../src/ai/agents/customer-calling/turn-trace';
import type { TurnTraceInput } from '../../../../src/ai/agents/customer-calling/turn-trace';

describe('normalizeTurnText', () => {
  const cases: Array<[string, string]> = [
    ['Book Garcia for Tuesday at 2 pm', 'book garcia for tuesday at 2 pm'],
    ['  Book   Garcia   for Tuesday at 2 pm  ', 'book garcia for tuesday at 2 pm'],
    ['Book Garcia for Tuesday at 2 pm.', 'book garcia for tuesday at 2 pm'],
    ['yes!', 'yes'],
    ['yes...', 'yes'],
    ['YES', 'yes'],
    ['', ''],
    ['   ', ''],
  ];

  it.each(cases)('normalizes %j → %j', (input, expected) => {
    expect(normalizeTurnText(input)).toBe(expected);
  });

  it('collides only on the SAME sentence — two different requests never dedup', () => {
    expect(normalizeTurnText('Book Garcia for Tuesday')).not.toBe(
      normalizeTurnText('Book Garcia for Thursday'),
    );
  });

  it('strips trailing punctuation but never internal words', () => {
    expect(normalizeTurnText('no, Thursday.')).toBe('no, thursday');
  });
});

describe('deriveTurnTrace — stage precedence', () => {
  const base: TurnTraceInput = { finalState: 'intent_capture' };

  it('a queued proposal is `committed`, not `proposal_created`', () => {
    const trace = deriveTurnTrace({
      ...base,
      finalState: 'closing',
      proposalMinted: true,
      proposalType: 'create_appointment',
      auditEventTypes: ['agent.calling.proposal_draft.proposal_queued'],
    });
    expect(trace.stage).toBe('committed');
    expect(trace.proposalType).toBe('create_appointment');
  });

  it('a minted-but-not-yet-queued proposal is `proposal_created`', () => {
    const trace = deriveTurnTrace({
      ...base,
      finalState: 'proposal_draft',
      proposalMinted: true,
      proposalType: 'create_appointment',
    });
    expect(trace.stage).toBe('proposal_created');
  });

  it('a read-only lookup answer is `answered` and mints nothing', () => {
    const trace = deriveTurnTrace({
      ...base,
      intent: 'lookup_day_overview',
      confidence: 0.98,
      answered: true,
      resolution: 'skipped',
    });
    expect(trace.stage).toBe('answered');
    expect(trace.proposalType).toBeUndefined();
  });

  it('an on-call page is `escalated` with fallbackReason escalation', () => {
    const trace = deriveTurnTrace({
      ...base,
      finalState: 'escalating',
      sideEffectTypes: ['audit_log', 'tts_play', 'notify_oncall'],
    });
    expect(trace.stage).toBe('escalated');
    expect(trace.fallbackReason).toBe('escalation');
  });

  it('the #846 nothing-pending guard is `guarded` / `guard`', () => {
    const trace = deriveTurnTrace({
      ...base,
      auditEventTypes: ['agent.calling.closing.confirm_without_pending'],
      sideEffectTypes: ['audit_log', 'tts_play'],
    });
    expect(trace.stage).toBe('guarded');
    expect(trace.fallbackReason).toBe('guard');
  });

  it('the voice-approval refusal is `guarded` / `refusal`', () => {
    const trace = deriveTurnTrace({ ...base, refused: true });
    expect(trace.stage).toBe('guarded');
    expect(trace.fallbackReason).toBe('refusal');
  });

  it('intent_confirm is `confirmation_asked`', () => {
    const trace = deriveTurnTrace({
      ...base,
      finalState: 'intent_confirm',
      intent: 'create_appointment',
      confidence: 0.94,
      resolution: 'resolved',
    });
    expect(trace.stage).toBe('confirmation_asked');
    expect(trace.resolution).toBe('resolved');
  });

  it('entity_confirm and entity_ambiguous both read as `clarification_asked`', () => {
    expect(
      deriveTurnTrace({ ...base, finalState: 'entity_confirm', resolution: 'low_confidence' }).stage,
    ).toBe('clarification_asked');
    expect(
      deriveTurnTrace({ ...base, finalState: 'entity_resolution', resolution: 'ambiguous' }).stage,
    ).toBe('clarification_asked');
  });

  it('a resolved reference with no readback yet is `entities_resolved`', () => {
    const trace = deriveTurnTrace({
      ...base,
      finalState: 'intent_capture',
      intent: 'notify_delay',
      confidence: 0.9,
      resolution: 'resolved',
    });
    expect(trace.stage).toBe('entities_resolved');
  });

  it('an intent at or above tau_int with nothing else is `intent_detected`', () => {
    expect(
      deriveTurnTrace({ ...base, intent: 'create_appointment', confidence: 0.75 }).stage,
    ).toBe('intent_detected');
  });

  it('an intent BELOW tau_int is not detected — it is `none`', () => {
    expect(
      deriveTurnTrace({ ...base, intent: 'create_appointment', confidence: 0.5 }).stage,
    ).toBe('none');
  });

  it('`unknown` is never a detected intent, whatever the confidence', () => {
    expect(deriveTurnTrace({ ...base, intent: 'unknown', confidence: 0.99 }).stage).toBe('none');
  });
});

describe('deriveTurnTrace — dedup and fallback reasons', () => {
  it('a duplicate turn is `guarded` / duplicate_turn with no fallback noise', () => {
    const trace = deriveTurnTrace({
      finalState: 'intent_confirm',
      dedup: 'duplicate_turn',
      sideEffectTypes: ['audit_log', 'tts_play'],
    });
    expect(trace.stage).toBe('guarded');
    expect(trace.dedup).toBe('duplicate_turn');
    expect(trace.fallbackReason).toBeUndefined();
  });

  it('a noise turn is `guarded` / noise and reports the reprompt', () => {
    const trace = deriveTurnTrace({
      finalState: 'intent_capture',
      dedup: 'noise',
      auditEventTypes: ['agent.calling.intent_capture.noise_reprompt'],
    });
    expect(trace.stage).toBe('guarded');
    expect(trace.dedup).toBe('noise');
    expect(trace.fallbackReason).toBe('reprompt');
  });

  it('dedup wins over every other stage — a recovery turn advanced nothing', () => {
    const trace = deriveTurnTrace({
      finalState: 'intent_confirm',
      dedup: 'duplicate_turn',
      resolution: 'resolved',
      intent: 'create_appointment',
      confidence: 0.94,
    });
    expect(trace.stage).toBe('guarded');
  });

  it('a voice_clarification degrade names itself', () => {
    const trace = deriveTurnTrace({
      finalState: 'closing',
      proposalMinted: true,
      proposalType: 'voice_clarification',
    });
    expect(trace.stage).toBe('committed');
    expect(trace.fallbackReason).toBe('clarification_card');
  });

  it('a classifier failure is reported ahead of the escalation it caused', () => {
    const trace = deriveTurnTrace({
      finalState: 'escalating',
      classifierFailureClass: 'provider',
      sideEffectTypes: ['audit_log', 'notify_oncall'],
    });
    expect(trace.stage).toBe('escalated');
    expect(trace.fallbackReason).toBe('classifier_failure:provider');
  });

  it('the FSM reprompt is reported as `reprompt`', () => {
    const trace = deriveTurnTrace({
      finalState: 'intent_capture',
      intent: 'unknown',
      confidence: 0,
      auditEventTypes: ['agent.calling.intent_capture.reprompt'],
    });
    expect(trace.stage).toBe('none');
    expect(trace.fallbackReason).toBe('reprompt');
  });

  it('lookup unavailable / refused are distinct, and both guard', () => {
    expect(deriveTurnTrace({ finalState: 'intent_capture', lookupUnavailable: true })).toEqual({
      stage: 'guarded',
      fallbackReason: 'lookup_unavailable',
    });
    expect(deriveTurnTrace({ finalState: 'intent_capture', lookupRefused: true })).toEqual({
      stage: 'guarded',
      fallbackReason: 'lookup_refused',
    });
  });

  it('omits every optional field it has no evidence for', () => {
    expect(deriveTurnTrace({ finalState: 'intent_capture' })).toEqual({ stage: 'none' });
  });
});
