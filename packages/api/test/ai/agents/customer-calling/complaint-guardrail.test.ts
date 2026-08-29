/**
 * #846 — live-FSM complaint guardrail global guard
 * (src/ai/agents/customer-calling/transitions.ts). Mirrors the negotiation
 * guardrail net one guard up: fixed acknowledgment on every complaint turn,
 * owner follow-up proposal only on the first.
 */
import { describe, it, expect } from 'vitest';
import {
  transition,
  COMPLAINT_ACK_LINE,
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

const complaintEvent: CallingAgentEvent = {
  type: 'intent_classified',
  intentType: 'complaint',
  entities: { noteBody: 'the tech left the yard a mess and never came back' },
  confidence: 0.95,
  aiRunId: 'run-1',
};

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((f) => f.type === 'tts_play').map((f) => (f.payload as { text: string }).text);
}

function creates(fx: SideEffect[]): SideEffect[] {
  return fx.filter((f) => f.type === 'create_proposal');
}

describe('complaint guardrail global guard', () => {
  it('speaks the acknowledgment and emits one owner-follow-up create_proposal, staying in state', () => {
    const result = transition('intent_capture', complaintEvent, baseContext);

    // Stays in the current state — a complaint is context for a human, not a
    // reason to derail the call.
    expect(result.nextState).toBe('intent_capture');
    expect(ttsTexts(result.sideEffects)).toContain(COMPLAINT_ACK_LINE);
    // Tagged so a settings-aware processor can brand-voice the line.
    const tts = result.sideEffects.find((f) => f.type === 'tts_play');
    expect((tts?.payload as { source?: string }).source).toBe('complaint_ack');

    const cp = creates(result.sideEffects);
    expect(cp).toHaveLength(1);
    const payload = cp[0].payload as Record<string, unknown>;
    expect(payload.intent).toBe('complaint');
    expect((payload.entities as Record<string, unknown>).noteBody).toBe(
      'the tech left the yard a mess and never came back',
    );
    // Verified caller-ID identity travels with the proposal.
    expect((payload.entities as Record<string, unknown>).customerId).toBe('cust-1');
    expect(payload.sessionId).toBe('session-test');
    // Real classify-run id threaded through for the ai_runs FK.
    expect(payload.aiRunId).toBe('run-1');

    // Marks the session so a restated complaint doesn't spawn another follow-up.
    expect(result.updatedContext.complaintFlagged).toBe(true);
  });

  it('emits the quality event for the transports that execute it', () => {
    const result = transition('intent_capture', complaintEvent, baseContext);
    const quality = result.sideEffects.find((f) => f.type === 'emit_quality_event');
    expect((quality?.payload as { eventType?: string }).eventType).toBe('complaint_guardrail');
  });

  it('never escalates to a human (unlike operator_request)', () => {
    const result = transition('intent_capture', complaintEvent, baseContext);
    expect(result.nextState).not.toBe('escalating');
    expect(result.sideEffects.some((f) => f.type === 'notify_oncall')).toBe(false);
  });

  it('is idempotent: when already flagged, it still acknowledges but creates no new follow-up', () => {
    const result = transition('intent_capture', complaintEvent, {
      ...baseContext,
      complaintFlagged: true,
    });
    expect(ttsTexts(result.sideEffects)).toContain(COMPLAINT_ACK_LINE);
    expect(creates(result.sideEffects)).toHaveLength(0);
    expect(result.nextState).toBe('intent_capture');
  });

  it('no-ops once the call is escalating or terminated', () => {
    for (const state of ['escalating', 'terminated'] as const) {
      const result = transition(state, complaintEvent, baseContext);
      expect(result.nextState).toBe(state);
      expect(creates(result.sideEffects)).toHaveLength(0);
    }
  });
});
