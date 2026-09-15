/**
 * #846 — a bare `confirm` ("yes") with nothing pending is a spoken
 * re-prompt, never a `voice_clarification` card
 * (src/ai/agents/customer-calling/transitions.ts). The guard covers BOTH
 * states the adapters classify in — intent_capture AND closing (the
 * adapters gate classification on `intent_capture || closing`, so a bare
 * "yes" in closing used to fall through and mint a clarification card);
 * `intent_confirm`'s correction handling stays untouched.
 */
import { describe, it, expect } from 'vitest';
import {
  transition,
  CONFIRM_NOTHING_PENDING_LINE,
} from '../../../../src/ai/agents/customer-calling/transitions';
import type {
  CallingAgentContext,
  CallingAgentEvent,
  SideEffect,
} from '../../../../src/ai/agents/customer-calling/types';

const baseContext: CallingAgentContext = {
  sessionId: 'session-test',
  tenantId: 'tenant-test',
  channel: 'telephony',
  callSid: 'CA-1',
  customerId: 'cust-1',
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
};

const confirmEvent: CallingAgentEvent = {
  type: 'intent_classified',
  intentType: 'confirm',
  entities: {},
  confidence: 0.95,
};

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((f) => f.type === 'tts_play').map((f) => (f.payload as { text: string }).text);
}

describe('bare confirm at intent_capture (nothing pending)', () => {
  it('speaks the re-prompt and stays in intent_capture with no proposal', () => {
    const result = transition('intent_capture', confirmEvent, baseContext);

    expect(result.nextState).toBe('intent_capture');
    expect(ttsTexts(result.sideEffects)).toContain(CONFIRM_NOTHING_PENDING_LINE);
    expect(result.sideEffects.some((f) => f.type === 'create_proposal')).toBe(false);
    // No funnel state is mutated — the next turn is a fresh classification.
    expect(result.updatedContext).toEqual(baseContext);
  });

  it('speaks the re-prompt and stays in closing with no proposal (a bare "yes" after a wrap-up)', () => {
    const result = transition('closing', confirmEvent, baseContext);

    expect(result.nextState).toBe('closing');
    expect(ttsTexts(result.sideEffects)).toContain(CONFIRM_NOTHING_PENDING_LINE);
    expect(result.sideEffects.some((f) => f.type === 'create_proposal')).toBe(false);
    expect(result.updatedContext).toEqual(baseContext);
  });

  it('does NOT intercept confirm inside intent_confirm — that state keeps its correction handling', () => {
    const result = transition('intent_confirm', confirmEvent, {
      ...baseContext,
      currentIntent: 'create_appointment',
    });

    // intent_classified inside intent_confirm is treated as a correction
    // (pre-existing behavior): back to intent_capture with the correction
    // copy, not the nothing-pending re-prompt.
    expect(result.nextState).toBe('intent_capture');
    expect(ttsTexts(result.sideEffects)).not.toContain(CONFIRM_NOTHING_PENDING_LINE);
    expect(result.updatedContext.currentIntent).toBeUndefined();
  });
});
