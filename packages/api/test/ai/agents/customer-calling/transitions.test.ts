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
