import { describe, it, expect } from 'vitest';
import { transition } from '../../../../src/ai/agents/customer-calling/transitions';
import type { CallingAgentContext } from '../../../../src/ai/agents/customer-calling/types';

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
