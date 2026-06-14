/**
 * N-003 (P2-036) — live-FSM negotiation guardrail global guard
 * (src/ai/agents/customer-calling/transitions.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  transition,
  NEGOTIATION_HOLDING_LINE,
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

const negotiationEvent: CallingAgentEvent = {
  type: 'intent_classified',
  intentType: 'negotiation',
  entities: { negotiationAsk: 'can you knock fifty bucks off?' },
  confidence: 0.95,
};

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((f) => f.type === 'tts_play').map((f) => (f.payload as { text: string }).text);
}

function creates(fx: SideEffect[]): SideEffect[] {
  return fx.filter((f) => f.type === 'create_proposal');
}

describe('negotiation guardrail global guard', () => {
  it('speaks the holding line and emits one owner-callback create_proposal, staying in state', () => {
    const result = transition('intent_capture', negotiationEvent, baseContext);

    // Stays in the current state — does NOT escalate or advance the funnel.
    expect(result.nextState).toBe('intent_capture');
    expect(ttsTexts(result.sideEffects)).toContain(NEGOTIATION_HOLDING_LINE);
    // Tagged so the settings-aware processor can brand-voice the line.
    const tts = result.sideEffects.find((f) => f.type === 'tts_play');
    expect((tts?.payload as { source?: string }).source).toBe('negotiation_holding');

    const cp = creates(result.sideEffects);
    expect(cp).toHaveLength(1);
    const payload = cp[0].payload as Record<string, unknown>;
    expect(payload.intent).toBe('negotiation');
    expect((payload.entities as Record<string, unknown>).negotiationAsk).toBe(
      'can you knock fifty bucks off?',
    );
    expect(payload.sessionId).toBe('session-test');

    // Marks the session so repeated pushback doesn't spawn another callback.
    expect(result.updatedContext.negotiationFlagged).toBe(true);
  });

  it('never escalates to a human (unlike operator_request)', () => {
    const result = transition('intent_capture', negotiationEvent, baseContext);
    expect(result.nextState).not.toBe('escalating');
    expect(result.sideEffects.some((f) => f.type === 'notify_oncall')).toBe(false);
  });

  it('is idempotent: when already flagged, it still deflects but creates no new callback', () => {
    const result = transition('intent_capture', negotiationEvent, {
      ...baseContext,
      negotiationFlagged: true,
    });
    expect(ttsTexts(result.sideEffects)).toContain(NEGOTIATION_HOLDING_LINE);
    expect(creates(result.sideEffects)).toHaveLength(0);
    expect(result.nextState).toBe('intent_capture');
  });

  it('no-ops once the call is escalating or terminated', () => {
    for (const state of ['escalating', 'terminated'] as const) {
      const result = transition(state, negotiationEvent, baseContext);
      expect(result.nextState).toBe(state);
      expect(creates(result.sideEffects)).toHaveLength(0);
    }
  });
});
