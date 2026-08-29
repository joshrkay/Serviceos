/**
 * #846 / D-027 — live-FSM complaint guardrail global guard
 * (src/ai/agents/customer-calling/transitions.ts). A complaint on a live
 * call ESCALATES TO A HUMAN (owner decision 2026-08-28), mirroring the
 * operator_request guard: acknowledgment + fast-path to `escalating` +
 * notify_oncall. The one-shot owner `callback` proposal is kept as the
 * escalation's paper trail (idempotent via complaintFlagged).
 */
import { describe, it, expect } from 'vitest';
import {
  transition,
  COMPLAINT_ESCALATION_LINE,
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
  utterance: 'the tech left the yard a mess and never came back, I want someone out here',
};

function ttsTexts(fx: SideEffect[]): string[] {
  return fx.filter((f) => f.type === 'tts_play').map((f) => (f.payload as { text: string }).text);
}

function creates(fx: SideEffect[]): SideEffect[] {
  return fx.filter((f) => f.type === 'create_proposal');
}

describe('complaint guardrail global guard (escalates, D-027)', () => {
  it('acknowledges, escalates to a human, and emits one paper-trail create_proposal', () => {
    const result = transition('intent_capture', complaintEvent, baseContext);

    // D-027: an unhappy caller gets a person, like operator_request — not a
    // deflect-and-continue.
    expect(result.nextState).toBe('escalating');
    expect(result.updatedContext.escalationReason).toBe('complaint');
    expect(result.sideEffects.some((f) => f.type === 'notify_oncall')).toBe(true);
    const oncall = result.sideEffects.find((f) => f.type === 'notify_oncall');
    expect((oncall?.payload as { reason?: string }).reason).toBe('complaint');

    expect(ttsTexts(result.sideEffects)).toContain(COMPLAINT_ESCALATION_LINE);
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
    // The caller's RAW words travel too — severity detection runs over them,
    // not just classifier-extracted entities (#846 review fix).
    expect(payload.utterance).toBe(
      'the tech left the yard a mess and never came back, I want someone out here',
    );
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

  it('escalates from closing too — the guard is global across live states', () => {
    const result = transition('closing', complaintEvent, baseContext);
    expect(result.nextState).toBe('escalating');
    expect(creates(result.sideEffects)).toHaveLength(1);
  });

  it('creates no second follow-up when already flagged (paper trail is one-shot)', () => {
    const result = transition('intent_capture', complaintEvent, {
      ...baseContext,
      complaintFlagged: true,
    });
    expect(result.nextState).toBe('escalating');
    expect(ttsTexts(result.sideEffects)).toContain(COMPLAINT_ESCALATION_LINE);
    expect(creates(result.sideEffects)).toHaveLength(0);
  });

  it('no-ops once the call is escalating or terminated (idempotent, like operator_request)', () => {
    for (const state of ['escalating', 'terminated'] as const) {
      const result = transition(state, complaintEvent, baseContext);
      expect(result.nextState).toBe(state);
      // Nothing observable happens: no second proposal, no second page,
      // nothing spoken. (An audit-only event_ignored record is fine.)
      expect(creates(result.sideEffects)).toHaveLength(0);
      expect(result.sideEffects.some((f) => f.type === 'notify_oncall')).toBe(false);
      expect(ttsTexts(result.sideEffects)).toHaveLength(0);
    }
  });
});
