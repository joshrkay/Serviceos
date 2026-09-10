/**
 * SCH-D3 — an operator's entity miss is not an escalation.
 *
 * Pure FSM tests (no adapter, no repos, no I/O) for the channel split inside
 * `escalateEntityNotFound`:
 *
 *   TELEPHONY (unchanged) — an inbound CALLER who names a record we cannot
 *   find has no other way forward: the call escalates and on-call is paged.
 *
 *   IN-APP — the authenticated operator's own app surface. Paging the
 *   on-call human because an operator mistyped a customer name ("cancel the
 *   Patel appointment" for a customer who does not exist) is not a recovery
 *   path; it is an interruption for somebody else. The session says honestly
 *   what it could not find, returns to `intent_capture`, and pages nobody.
 *
 * Register case `cancel-02` is exactly this: `expect.forbidSideEffects:
 * ['notify_oncall']`, `allowedStates: ['intent_capture','closing']`, a spoken
 * "couldn't find", and zero proposals.
 */
import { describe, it, expect } from 'vitest';
import { transition } from '../../../../src/ai/agents/customer-calling/transitions';
import { renderTtsText } from '../../../../src/ai/agents/customer-calling/tts-copy';
import type { CallingAgentContext } from '../../../../src/ai/agents/customer-calling/types';

const inappContext: CallingAgentContext = {
  sessionId: 'session-inapp',
  tenantId: 'tenant-test',
  channel: 'inapp',
  currentIntent: 'cancel_appointment',
  extractedEntities: { customerName: 'Patel' },
  retryCount: 0,
  repromptCount: 0,
  startedAt: Date.now(),
};

const telephonyContext: CallingAgentContext = {
  ...inappContext,
  sessionId: 'session-phone',
  channel: 'telephony',
};

function spokenText(
  result: ReturnType<typeof transition>,
  lang: 'en' | 'es' = 'en',
): string | undefined {
  const tts = result.sideEffects.find((fx) => fx.type === 'tts_play');
  if (!tts || typeof tts.payload.text !== 'string') return undefined;
  return renderTtsText(tts.payload.text, tts.payload, lang);
}

describe('entity_not_found — in-app operator session', () => {
  it('returns to intent_capture, speaks an honest not-found, and pages NOBODY', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'customer', reference: 'Patel' },
      inappContext,
    );

    expect(result.nextState).toBe('intent_capture');
    const types = result.sideEffects.map((fx) => fx.type);
    expect(types).not.toContain('notify_oncall');
    expect(types).not.toContain('create_proposal');
    expect(types).not.toContain('end_session');
    // Not an escalation, so no escalationReason is stamped either.
    expect(result.updatedContext.escalationReason).toBeUndefined();
  });

  it('names what was not found, and offers the two real ways forward', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'customer', reference: 'Patel' },
      inappContext,
    );

    expect(spokenText(result)).toBe(
      "I couldn't find a matching customer for Patel. Want to try a different name, or create it?",
    );
  });

  it('falls back to the generic noun when the producer had no detail in hand', () => {
    const result = transition('entity_resolution', { type: 'entity_not_found' }, inappContext);
    expect(spokenText(result)).toBe(
      "I couldn't find a matching record. Want to try a different name, or create it?",
    );
  });

  it('is localized, not an English sentence leaking into a Spanish session', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'appointment', reference: 'Patel' },
      inappContext,
    );
    expect(spokenText(result, 'es')).toContain('No encontré una cita');
  });

  it('audits entity_not_found_operator with the reference, not the escalation event', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'customer', reference: 'Patel' },
      inappContext,
    );

    const audit = result.sideEffects.find((fx) => fx.type === 'audit_log');
    expect(audit?.payload.eventType).toBe(
      'agent.calling.entity_resolution.entity_not_found_operator',
    );
    expect(audit?.payload).toMatchObject({ entityKind: 'customer', reference: 'Patel' });
  });

  it('clears the parked request so the next name is captured cleanly', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'customer', reference: 'Patel' },
      inappContext,
    );

    expect(result.updatedContext.currentIntent).toBeUndefined();
    expect(result.updatedContext.extractedEntities).toBeUndefined();
    expect(result.updatedContext.pendingEntityAmbiguity).toBeUndefined();
    expect(result.updatedContext.pendingEntityConfirmation).toBeUndefined();
  });

  it('applies to a DECLINED entity_confirm too — the candidate was wrong, not the session', () => {
    const pending: CallingAgentContext = {
      ...inappContext,
      pendingEntityConfirmation: {
        entityKind: 'job',
        candidate: { id: 'job-9', kind: 'job', label: 'QA Matrix Repair', score: 0.7 },
        reference: 'the QA Matrix job',
        refKey: 'jobId',
        partialRefs: {},
      },
    };
    const result = transition('entity_confirm', { type: 'entity_confirm_declined' }, pending);

    expect(result.nextState).toBe('intent_capture');
    expect(result.sideEffects.map((fx) => fx.type)).not.toContain('notify_oncall');
    expect(spokenText(result)).toBe(
      "I couldn't find a matching job for the QA Matrix job. Want to try a different name, or create it?",
    );
    const audit = result.sideEffects.find((fx) => fx.type === 'audit_log');
    expect(audit?.payload.eventType).toBe(
      'agent.calling.entity_confirm.entity_not_found_operator',
    );
    // Which seam asked is still recorded — the old audit encoded it in the
    // event type.
    expect(audit?.payload.resolutionEvent).toBe('entity_confirm_declined');
  });
});

describe('entity_not_found — telephony is untouched (regression fence for 46a954e1)', () => {
  it('still escalates to on-call with the caller-facing line and escalationReason', () => {
    const result = transition(
      'entity_resolution',
      { type: 'entity_not_found', entityKind: 'customer', reference: 'Patel' },
      telephonyContext,
    );

    expect(result.nextState).toBe('escalating');
    expect(result.sideEffects.map((fx) => fx.type)).toContain('notify_oncall');
    expect(result.updatedContext.escalationReason).toBe('entity_not_found');
    expect(spokenText(result)).toContain("wasn't able to find the record");
    // The caller's request is NOT cleared — the escalation summary reads it.
    expect(result.updatedContext.currentIntent).toBe('cancel_appointment');
  });

  it('still escalates a declined entity_confirm', () => {
    const result = transition(
      'entity_confirm',
      { type: 'entity_confirm_declined' },
      telephonyContext,
    );
    expect(result.nextState).toBe('escalating');
    expect(result.sideEffects.map((fx) => fx.type)).toContain('notify_oncall');
    expect(result.updatedContext.escalationReason).toBe('entity_not_found');
  });
});
