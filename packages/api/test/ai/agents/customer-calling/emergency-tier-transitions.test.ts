/**
 * ANS-001 — falsifiable-clause suite for the FSM safety-tier branch.
 *
 * Goal clause 2 (safety beats containment): "life-safety calls escalated
 * immediately and NEVER booked", including aborting + revoking a booking
 * already in progress when an E1 signal appears mid-call, and never keeping
 * the caller on the line for a dispatcher bridge / data capture.
 *
 * These assertions run against the PURE reducer (`transition`) — no I/O — so
 * they are exhaustive and deterministic. The processor/adapter tests prove the
 * side effects are actually executed.
 */
import { describe, it, expect } from 'vitest';
import { transition } from '../../../../src/ai/agents/customer-calling/transitions';
import type {
  CallingAgentContext,
  CallingAgentEvent,
  CallingAgentState,
  SideEffect,
} from '../../../../src/ai/agents/customer-calling/types';
import { EMERGENCY_SAFETY_LINE } from '../../../../src/ai/agents/customer-calling/emergency-detector';
import { SENTENCE_CATALOG_ES } from '../../../../src/ai/agents/customer-calling/tts-copy';

const baseContext: CallingAgentContext = {
  sessionId: 'session-e1',
  tenantId: 'tenant-e1',
  channel: 'telephony',
  callSid: 'CA-e1',
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
};

const E1_EVENT: CallingAgentEvent = {
  type: 'emergency_detected',
  keyword: 'smell gas',
  utterance: 'I smell gas in the house',
  tier: 'E1',
  responseScript:
    'If anyone is in immediate danger, hang up and call 911 now. Please leave the building immediately.',
};

const types = (fx: SideEffect[]) => fx.map((f) => f.type);

// Every non-terminal state — continuous screening must fire from all of them,
// including mid-booking (proposal_draft) and after a booking was queued (closing).
const NON_TERMINAL_STATES: CallingAgentState[] = [
  'greeting',
  'identifying',
  'ask_caller',
  'intent_capture',
  'entity_resolution',
  'intent_confirm',
  'proposal_draft',
  'closing',
];

describe('ANS-001 E1 — life safety never books, from any state', () => {
  it.each(NON_TERMINAL_STATES)(
    'from %s: E1 goes terminal, never books, never bridges, revokes + notifies',
    (state) => {
      const result = transition(state, E1_EVENT, baseContext);
      const t = types(result.sideEffects);

      // Never booked: no proposal of any kind is created on an E1 turn.
      expect(t).not.toContain('create_proposal');
      // No dispatcher bridge / data capture: notify_oncall is the bridge path.
      expect(t).not.toContain('notify_oncall');
      // Revokes any in-progress booking.
      expect(t).toContain('revoke_pending_bookings');
      // Notifies the tenant on every channel (without bridging the caller).
      expect(t).toContain('notify_tenant_emergency');
      // Closes the call — does not keep the caller on the line.
      expect(t).toContain('end_session');
      // Terminal outcome, not the escalating/booking flow.
      expect(result.nextState).toBe('terminated');
    },
  );

  it('speaks the reviewed life-safety script first, tagged priority:safety', () => {
    const result = transition('intent_confirm', E1_EVENT, baseContext);
    const firstTts = result.sideEffects.find((f) => f.type === 'tts_play');
    expect(firstTts).toBeDefined();
    expect((firstTts!.payload as { text: string }).text).toMatch(/911/);
    expect((firstTts!.payload as { priority?: string }).priority).toBe('safety');
  });

  it('audits the call as an E1 life-safety event', () => {
    const result = transition('proposal_draft', E1_EVENT, baseContext);
    const audit = result.sideEffects.find((f) => f.type === 'audit_log');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.payload)).toMatch(/E1|life_safety/);
  });

  it('is idempotent once terminated (no double action)', () => {
    const result = transition('terminated', E1_EVENT, baseContext);
    // terminated is terminal — the global guard must not re-fire.
    expect(types(result.sideEffects)).not.toContain('revoke_pending_bookings');
    expect(result.nextState).toBe('terminated');
  });
});

describe('#1220 review — a Spanish E1 caller hears the catalogued Spanish 911 line before the E1 script', () => {
  const ES_911_LINE = SENTENCE_CATALOG_ES[EMERGENCY_SAFETY_LINE];
  const ttsPayloads = (fx: SideEffect[]) =>
    fx.filter((f) => f.type === 'tts_play').map((f) => f.payload as Record<string, unknown>);

  it.each([
    ['the matched phrase is Spanish', { language: 'es' as const }],
    ['the session speaks Spanish', { language: 'en' as const, sessionLanguage: 'es' as const }],
  ])('when %s: Spanish 911 line (es, safety, held against barge-in), then the E1 script', (_why, langs) => {
    expect(ES_911_LINE).toBe('Si alguien está en peligro inmediato, cuelgue y llame al 911.');
    const result = transition('intent_capture', { ...E1_EVENT, ...langs }, baseContext);
    const tts = ttsPayloads(result.sideEffects);
    expect(tts).toHaveLength(2);
    expect(tts[0]).toMatchObject({
      text: ES_911_LINE,
      language: 'es',
      priority: 'safety',
      tier: 'E1',
      holdBargeInUntilPlayed: true,
    });
    expect(tts[1]).toMatchObject({ text: (E1_EVENT as { responseScript: string }).responseScript, priority: 'safety', tier: 'E1' });
    expect(result.nextState).toBe('terminated');
  });

  it('an English E1 on an English session is unchanged: the E1 script is the only line', () => {
    for (const event of [E1_EVENT, { ...E1_EVENT, language: 'en' as const, sessionLanguage: 'en' as const }]) {
      const tts = ttsPayloads(transition('intent_capture', event, baseContext).sideEffects);
      expect(tts).toHaveLength(1);
      expect(tts[0]!.text).toBe((E1_EVENT as { responseScript: string }).responseScript);
    }
  });
});

describe('ANS-001 E2 — existing dispatcher-escalation behavior is unchanged', () => {
  const e2Event = (tier?: 'E2'): CallingAgentEvent => ({
    type: 'emergency_detected',
    keyword: 'flooding',
    utterance: 'the basement is flooding',
    ...(tier ? { tier } : {}),
  });

  it.each([undefined, 'E2' as const])(
    'tier=%s escalates with dispatcher bridge + emergency_dispatch proposal (regression guard)',
    (tier) => {
      const result = transition('intent_capture', e2Event(tier), baseContext);
      const t = types(result.sideEffects);
      expect(result.nextState).toBe('escalating');
      expect(t).toContain('create_proposal');
      expect(t).toContain('notify_oncall');
      // E2 does NOT revoke bookings or use the E1 terminal-notify path.
      expect(t).not.toContain('revoke_pending_bookings');
      expect(t).not.toContain('notify_tenant_emergency');
    },
  );
});
