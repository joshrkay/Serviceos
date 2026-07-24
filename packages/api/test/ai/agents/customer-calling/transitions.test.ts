import { describe, it, expect } from 'vitest';
import {
  transition,
  REFINEMENT_CAP_LINE,
  POST_QUOTE_REPROMPT_LINE,
  MAX_REFINEMENTS_PER_CALL,
} from '../../../../src/ai/agents/customer-calling/transitions';
import type { CallingAgentContext } from '../../../../src/ai/agents/customer-calling/types';
import type { QuoteReadbackLine } from '../../../../src/ai/voice-turn/quote-readback';

const baseContext: CallingAgentContext = {
  sessionId: 'session-test',
  tenantId: 'tenant-test',
  channel: 'telephony',
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
  repairTemplates: [
    { trigger: 'low_intent_confidence', text: 'Is this about scheduling a visit, or is something not working right now?' },
    { trigger: 'low_audio_confidence', text: "I'm having trouble hearing you — could you say that one more time?" },
  ],
};

describe('intent_capture low-confidence reprompt', () => {
  it('uses the vertical low_intent_confidence template when present (intent_classified event)', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'unknown', entities: {}, confidence: 0.4 },
      baseContext
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain('scheduling a visit');
  });

  it('falls back to the generic reprompt when no templates are supplied (intent_classified event)', () => {
    const ctx: CallingAgentContext = { ...baseContext, repairTemplates: undefined };
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'unknown', entities: {}, confidence: 0.4 },
      ctx
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain('say that again');
  });

  it('uses the vertical low_audio_confidence template for the confidence_low event', () => {
    const result = transition(
      'intent_capture',
      { type: 'confidence_low', threshold: 0.75, score: 0.3 },
      baseContext
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain("having trouble hearing you");
  });

  it('falls back to generic reprompt for confidence_low when no templates supplied', () => {
    const ctx: CallingAgentContext = { ...baseContext, repairTemplates: undefined };
    const result = transition(
      'intent_capture',
      { type: 'confidence_low', threshold: 0.75, score: 0.3 },
      ctx
    );
    const ttsText = result.sideEffects
      .filter((fx) => fx.type === 'tts_play')
      .map((fx) => (fx.payload as { text: string }).text)
      .join('');
    expect(ttsText).toContain('say that again');
  });
});

describe('intent_capture operator_request fast-path', () => {
  it('transitions directly to escalating with reason operator_request', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.95 },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('operator_request');
    // Should NOT have entity_resolution or intent_confirm side effects.
    const sideEffectTypes = result.sideEffects.map((fx) => fx.type);
    expect(sideEffectTypes).not.toContain('create_proposal');
    expect(sideEffectTypes).toContain('tts_play');
    expect(sideEffectTypes).toContain('notify_oncall');
  });

  it('does not require confidence threshold for operator_request (treats any confidence as valid)', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.2 },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
  });
});

describe('operator_request fast-path from any state', () => {
  it('escalates from intent_confirm when caller asks for human', () => {
    const ctx: CallingAgentContext = {
      ...baseContext,
      currentIntent: 'create_appointment',
      extractedEntities: { service: 'HVAC repair' },
    };
    const result = transition(
      'intent_confirm',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.9 },
      ctx
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('operator_request');
  });

  it('escalates from closing when caller asks for human', () => {
    const result = transition(
      'closing',
      { type: 'intent_classified', intentType: 'operator_request', entities: {}, confidence: 0.9 },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('operator_request');
  });
});

describe('frustration_detected handler', () => {
  it('escalates from any non-terminal state with keyword source', () => {
    const result = transition(
      'intent_capture',
      { type: 'frustration_detected', source: 'keyword', detail: 'this is ridiculous' },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('keyword_frustration');
  });

  it('escalates from any non-terminal state with llm_sentiment source', () => {
    const result = transition(
      'intent_confirm',
      { type: 'frustration_detected', source: 'llm_sentiment', detail: '0.82' },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('llm_sentiment');
  });

  it('is idempotent when already in escalating state', () => {
    const result = transition(
      'escalating',
      { type: 'frustration_detected', source: 'keyword' },
      baseContext
    );
    expect(result.nextState).toBe('escalating');
    expect(result.sideEffects).toEqual([]);
  });
});

describe('RV-140/RV-142 — emergency_detected handler', () => {
  const event = {
    type: 'emergency_detected' as const,
    keyword: 'gas leak',
    utterance: 'I think we have a gas leak',
  };

  it('escalates from any non-terminal state with the 911 safety line FIRST', () => {
    for (const state of ['greeting', 'identifying', 'intent_capture', 'intent_confirm', 'closing'] as const) {
      const result = transition(state, event, baseContext);
      expect(result.nextState).toBe('escalating');
      expect(result.updatedContext.escalationReason).toBe('emergency_dispatch');
      expect(result.updatedContext.currentIntent).toBe('emergency_dispatch');
      const tts = result.sideEffects.filter((fx) => fx.type === 'tts_play');
      // RV-142 — safety script before any transfer copy.
      expect((tts[0]!.payload as { text: string }).text).toContain('911');
      expect(tts[0]!.payload.priority).toBe('safety');
      expect((tts[1]!.payload as { text: string }).text).toContain('emergency');
    }
  });

  it('queues an emergency_dispatch proposal with the utterance + keyword (RV-141 payload)', () => {
    const result = transition('intent_capture', event, baseContext);
    const proposal = result.sideEffects.find((fx) => fx.type === 'create_proposal');
    expect(proposal).toBeDefined();
    expect(proposal!.payload.intent).toBe('emergency_dispatch');
    // RIVET P4 — the deterministic keyword path marks the proposal
    // systemDetected so the S1 surface guard exempts it from coercion to a
    // non-executable clarification (a real emergency must still open the job).
    expect(proposal!.payload.systemDetected).toBe(true);
    const entities = proposal!.payload.entities as Record<string, unknown>;
    expect(entities.emergencyDescription).toBe(event.utterance);
    expect(entities.detectedKeywords).toEqual(['gas leak']);
  });

  it('fires notify_oncall with reason emergency_dispatch', () => {
    const result = transition('intent_capture', event, baseContext);
    const oncall = result.sideEffects.find((fx) => fx.type === 'notify_oncall');
    expect(oncall).toBeDefined();
    expect(oncall!.payload.reason).toBe('emergency_dispatch');
  });

  it('is idempotent in escalating (no double-page)', () => {
    const result = transition('escalating', event, baseContext);
    expect(result.nextState).toBe('escalating');
    expect(result.sideEffects).toEqual([]);
  });

  it('is inert in terminated (event ignored, audit only)', () => {
    const result = transition('terminated', event, baseContext);
    expect(result.nextState).toBe('terminated');
    expect(result.sideEffects.filter((fx) => fx.type !== 'audit_log')).toEqual([]);
  });

  it('classified emergency_dispatch intent fast-path also speaks the 911 line first (RV-142)', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'emergency_dispatch', entities: {}, confidence: 0.95 },
      baseContext,
    );
    expect(result.nextState).toBe('escalating');
    const tts = result.sideEffects.filter((fx) => fx.type === 'tts_play');
    expect((tts[0]!.payload as { text: string }).text).toContain('911');
  });
});

describe('ai_run_id threading across turns (PR #664 finding A)', () => {
  // A confirmed classify captures its ai_runs id into context.lastAiRunId so
  // the eventual create_proposal links the proposal to the REAL run. The bug:
  // a SUBSEQUENT classify whose turn has NO run must CLEAR the prior id — a
  // conditional spread left the stale id in place and the proposal linked to
  // the WRONG ai_runs audit record.

  it('a confidence-passing classify WITH aiRunId sets lastAiRunId', () => {
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'book_service', entities: {}, confidence: 0.9, aiRunId: 'run-1' },
      baseContext,
    );
    expect(result.nextState).toBe('entity_resolution');
    expect(result.updatedContext.lastAiRunId).toBe('run-1');
  });

  it('a SUBSEQUENT classify WITHOUT aiRunId CLEARS the prior turn id (no inheritance)', () => {
    // First turn seeds a run id (as a prior classify would have).
    const seeded: CallingAgentContext = { ...baseContext, lastAiRunId: 'run-1' };
    const result = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'reschedule', entities: {}, confidence: 0.9 },
      seeded,
    );
    expect(result.nextState).toBe('entity_resolution');
    // Must be cleared, NOT the leaked 'run-1'.
    expect(result.updatedContext.lastAiRunId).toBeUndefined();
  });

  it('create_proposal on confirm carries the CURRENT turn aiRunId (real run threaded)', () => {
    const ctx: CallingAgentContext = {
      ...baseContext,
      currentIntent: 'book_service',
      extractedEntities: { service: 'drain' },
      lastIntentConfidence: 0.9,
      lastAiRunId: 'run-2',
    };
    const result = transition('intent_confirm', { type: 'confirmed' }, ctx);
    const proposal = result.sideEffects.find((fx) => fx.type === 'create_proposal');
    expect(proposal).toBeDefined();
    expect((proposal!.payload as { aiRunId?: string }).aiRunId).toBe('run-2');
  });

  it('create_proposal on confirm omits aiRunId when the current turn had no run (never a stale id)', () => {
    // Simulate a full flow: turn 1 classifies WITH a run, gets corrected, then
    // turn 2 re-classifies WITHOUT a run. The proposal must not inherit run-1.
    const afterFirstClassify = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'book_service', entities: {}, confidence: 0.9, aiRunId: 'run-1' },
      baseContext,
    );
    expect(afterFirstClassify.updatedContext.lastAiRunId).toBe('run-1');

    // Caller corrects in intent_confirm — the captured turn is abandoned.
    const afterCorrection = transition(
      'intent_confirm',
      { type: 'correction', newTranscript: 'actually a reschedule' },
      { ...afterFirstClassify.updatedContext, currentIntent: 'book_service' },
    );
    expect(afterCorrection.nextState).toBe('intent_capture');
    expect(afterCorrection.updatedContext.lastAiRunId).toBeUndefined();

    // Turn 2 re-classifies WITHOUT a persisted run.
    const afterSecondClassify = transition(
      'intent_capture',
      { type: 'intent_classified', intentType: 'reschedule', entities: {}, confidence: 0.9 },
      afterCorrection.updatedContext,
    );
    expect(afterSecondClassify.updatedContext.lastAiRunId).toBeUndefined();

    // Confirm turn 2 → proposal must NOT carry the stale run-1.
    const confirmed = transition(
      'intent_confirm',
      { type: 'confirmed' },
      { ...afterSecondClassify.updatedContext, currentIntent: 'reschedule', extractedEntities: {} },
    );
    const proposal = confirmed.sideEffects.find((fx) => fx.type === 'create_proposal');
    expect(proposal).toBeDefined();
    expect((proposal!.payload as { aiRunId?: string }).aiRunId).toBeUndefined();
  });
});

// ─── WS18 — post-quote FSM surface ─────────────────────────────────────────

const gasketLine: QuoteReadbackLine = {
  description: 'Gasket',
  unitPrice: 450,
  quantity: 1,
  pricingSource: 'catalog',
};

function ttsTexts(sideEffects: ReturnType<typeof transition>['sideEffects']): string[] {
  return sideEffects
    .filter((fx) => fx.type === 'tts_play')
    .map((fx) => (fx.payload as { text: string }).text);
}

/** A `closing` context carrying a live catalog-grounded quote. */
function closingWithQuote(overrides: Partial<NonNullable<CallingAgentContext['pendingQuote']>> = {}): CallingAgentContext {
  return {
    ...baseContext,
    pendingProposalId: 'prop-1',
    pendingQuote: {
      proposalId: 'prop-1',
      groundedLines: [gasketLine],
      groundedClean: true,
      totalCents: 450,
      refinementCount: 0,
      ...overrides,
    },
  };
}

describe('WS18 — proposal_draft stashes pendingQuote for a grounded estimate', () => {
  it('sets pendingQuote (refinementCount 0) when proposal_queued carries grounded lines', () => {
    const result = transition(
      'proposal_draft',
      {
        type: 'proposal_queued',
        proposalId: 'prop-1',
        utterance: 'For the Gasket, that is typically $4.50. I will send the full quote to confirm.',
        groundedLines: [gasketLine],
        groundedClean: true,
        totalCents: 450,
      },
      baseContext,
    );
    expect(result.nextState).toBe('closing');
    expect(result.updatedContext.pendingQuote).toEqual({
      proposalId: 'prop-1',
      groundedLines: [gasketLine],
      groundedClean: true,
      totalCents: 450,
      refinementCount: 0,
    });
    // The read-back is still spoken (WS5 behavior preserved).
    expect(ttsTexts(result.sideEffects)[0]).toContain('$4.50');
  });

  it('leaves pendingQuote undefined for a non-estimate proposal (closing byte-stable)', () => {
    const result = transition(
      'proposal_draft',
      { type: 'proposal_queued', proposalId: 'prop-2' },
      baseContext,
    );
    expect(result.nextState).toBe('closing');
    expect(result.updatedContext.pendingQuote).toBeUndefined();
    expect(result.updatedContext.pendingProposalId).toBe('prop-2');
    // Fixed confirmation line for every non-estimate proposal.
    expect(ttsTexts(result.sideEffects)[0]).toContain("You'll receive a confirmation shortly");
  });
});

describe('WS18 — post_quote_affirmative (discard-bug fix)', () => {
  it('stays in closing and KEEPS pendingQuote (never discards the draft)', () => {
    const ctx = closingWithQuote();
    const result = transition('closing', { type: 'post_quote_affirmative' }, ctx);
    expect(result.nextState).toBe('closing');
    // The whole bug: the quote must survive the affirmative.
    expect(result.updatedContext.pendingQuote).toEqual(ctx.pendingQuote);
    expect(result.updatedContext.pendingProposalId).toBe('prop-1');
    // FSM speaks nothing here — the processor owns the spoken close.
    expect(ttsTexts(result.sideEffects)).toEqual([]);
    // Audit records the assent.
    const audit = result.sideEffects.find((fx) => fx.type === 'audit_log');
    expect(audit!.payload.eventType).toContain('post_quote_affirmative');
  });
});

describe('WS18 — refine_pending_quote', () => {
  it('speaks the fresh read-back, stays in closing, and increments refinementCount', () => {
    const ctx = closingWithQuote();
    const twoGaskets: QuoteReadbackLine = { ...gasketLine, quantity: 2 };
    const result = transition(
      'closing',
      {
        type: 'refine_pending_quote',
        proposalId: 'prop-1',
        groundedLines: [twoGaskets],
        groundedClean: true,
        totalCents: 900,
        utterance: '2 Gaskets are $9.00. I will send the full quote to confirm.',
      },
      ctx,
    );
    expect(result.nextState).toBe('closing');
    expect(ttsTexts(result.sideEffects)[0]).toContain('$9.00');
    expect(result.updatedContext.pendingQuote).toEqual({
      proposalId: 'prop-1',
      groundedLines: [twoGaskets],
      groundedClean: true,
      totalCents: 900,
      refinementCount: 1,
    });
  });

  it('past MAX_REFINEMENTS_PER_CALL speaks the owner-deferral line and keeps the last quote', () => {
    const ctx = closingWithQuote({ refinementCount: MAX_REFINEMENTS_PER_CALL });
    const result = transition(
      'closing',
      {
        type: 'refine_pending_quote',
        proposalId: 'prop-1',
        groundedLines: [gasketLine],
        groundedClean: true,
        totalCents: 450,
        utterance: 'ignored on the capped branch',
      },
      ctx,
    );
    expect(result.nextState).toBe('closing');
    expect(ttsTexts(result.sideEffects)).toEqual([REFINEMENT_CAP_LINE]);
    // Last accepted quote is preserved — the caller can still say "yes".
    expect(result.updatedContext.pendingQuote!.refinementCount).toBe(MAX_REFINEMENTS_PER_CALL);
  });
});

describe('WS18 — confidence_low in closing (dead-air fix)', () => {
  it('bounded-reprompts (not silence) when a pendingQuote is live', () => {
    const ctx = closingWithQuote();
    const result = transition('closing', { type: 'confidence_low', threshold: 0.75, score: 0.1 }, ctx);
    expect(result.nextState).toBe('closing');
    expect(ttsTexts(result.sideEffects)).toEqual([POST_QUOTE_REPROMPT_LINE]);
    expect(result.updatedContext.repromptCount).toBe(1);
    // Quote preserved.
    expect(result.updatedContext.pendingQuote).toEqual(ctx.pendingQuote);
  });

  it('escalates to a human once the reprompt budget is exhausted', () => {
    const ctx = closingWithQuote({ refinementCount: 0 });
    ctx.repromptCount = 2; // next confidence_low hits MAX_REPROMPTS (3)
    const result = transition('closing', { type: 'confidence_low', threshold: 0.75, score: 0.1 }, ctx);
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('low_confidence_intent');
    expect(result.sideEffects.some((fx) => fx.type === 'notify_oncall')).toBe(true);
  });

  it('a non-estimate closing (no pendingQuote) keeps the pre-WS18 ignored behavior', () => {
    const ctx: CallingAgentContext = { ...baseContext, pendingProposalId: 'prop-x' };
    const result = transition('closing', { type: 'confidence_low', threshold: 0.75, score: 0.1 }, ctx);
    // Ignored transition: same state, audit only, no reprompt tts.
    expect(result.nextState).toBe('closing');
    expect(ttsTexts(result.sideEffects)).toEqual([]);
  });
});

describe('WS18 — a genuine second intent still clears the quote', () => {
  it('second_intent → intent_capture and clears pendingQuote', () => {
    const ctx = closingWithQuote();
    const result = transition('closing', { type: 'second_intent' }, ctx);
    expect(result.nextState).toBe('intent_capture');
    expect(result.updatedContext.pendingQuote).toBeUndefined();
    expect(result.updatedContext.pendingProposalId).toBeUndefined();
  });

  it('intent_classified (second intent via classify) → intent_capture and clears pendingQuote', () => {
    const ctx = closingWithQuote();
    const result = transition(
      'closing',
      { type: 'intent_classified', intentType: 'create_appointment', entities: {}, confidence: 0.9 },
      ctx,
    );
    expect(result.nextState).toBe('intent_capture');
    expect(result.updatedContext.pendingQuote).toBeUndefined();
  });
});
