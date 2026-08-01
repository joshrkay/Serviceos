import { describe, it, expect, vi } from 'vitest';
import {
  planVoiceEntityLookups,
  resolveSchedulingEntities,
  resolveVoiceEntityReferences,
} from '../../../../src/ai/agents/customer-calling/entity-resolution';
import { resolveDateTime } from '../../../../src/ai/scheduling/resolve-datetime';
import type { EntityResolver, EntityResolverResult } from '../../../../src/ai/resolution/entity-resolver';

// VOX-52 regression (PR #665 review): the resolver rewrite must still carry the
// classifier's free-text fields (reason, assigneeName, noteText, …) into refs —
// only the identity keys (customerId/jobId/appointmentId) are the resolver's
// authority and are never copied raw from the classifier.
describe('resolveSchedulingEntities — carries free-text classifier fields into refs', () => {
  it('preserves non-identity string entities, drops raw identity keys', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'reassign_appointment', {
      assigneeName: 'Maria',
      reason: 'customer requested a different tech',
      noteText: 'gate code is 1234',
      customerId: 'not-a-uuid-should-not-leak',
    });
    expect(res.status).toBe('resolved');
    expect(res.refs.assigneeName).toBe('Maria');
    expect(res.refs.reason).toBe('customer requested a different tech');
    expect(res.refs.noteText).toBe('gate code is 1234');
    // Identity keys are never trusted raw from the classifier.
    expect(res.refs.customerId).toBeUndefined();
  });

  it('does not overwrite a classifier-provided cancellation reason with the default', async () => {
    const res = await resolveSchedulingEntities(undefined, 'tenant-1', 'cancel_appointment', {
      reason: 'rescheduling to next week',
    });
    expect(res.refs.reason).toBe('rescheduling to next week');
  });
});

// U4 (Part E punch #1) — spoken datetimes resolve in the TENANT's zone via
// the SAME `resolveDateTime` the recorded-memo path uses (the old
// `parseNaturalDatetime` did UTC-frame arithmetic regardless of zone —
// "the July timezone fixes missed this module"). Fixed "now" (a Monday) so
// weekday math is deterministic.
describe('resolveSchedulingEntities — tenant-timezone spoken datetimes (U4)', () => {
  // Monday 2026-08-03 noon in America/Chicago (CDT, UTC-5).
  const NOW = new Date('2026-08-03T17:00:00.000Z');
  const TZ = 'America/Chicago';

  it('"Thursday at 2pm" for an America/Chicago tenant → 14:00 CT stored as UTC (19:00Z), matching the memo path exactly', async () => {
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'create_appointment',
      { dateTimeDescription: 'Thursday at 2pm' },
      undefined,
      { timezone: TZ, now: NOW },
    );
    expect(res.refs.scheduledStart).toBe('2026-08-06T19:00:00.000Z');
    // Byte-identical to the recorded-memo path's resolver for the same
    // utterance + tenant — the two entry points can no longer disagree.
    const memo = resolveDateTime('Thursday at 2pm', { timezone: TZ, now: NOW });
    expect(memo.ok).toBe(true);
    if (!memo.ok) return;
    expect(res.refs.scheduledStart).toBe(memo.startUtc);
    expect(res.refs.scheduledEnd).toBe(memo.endUtc);
  });

  it('DST boundary week: the same wall-clock hour lands on the NEW offset (CDT 19:00Z → CST 20:00Z)', async () => {
    // Thursday 2026-10-29 noon CDT; "next Tuesday at 2pm" crosses the
    // 2026-11-01 fall-back. 2pm CST is UTC-6 → 20:00Z, where a frozen-offset
    // (or UTC-frame) parse would land an hour off.
    const beforeFallBack = new Date('2026-10-29T17:00:00.000Z');
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'create_appointment',
      { dateTimeDescription: 'next Tuesday at 2pm' },
      undefined,
      { timezone: TZ, now: beforeFallBack },
    );
    expect(res.refs.scheduledStart).toBe('2026-11-03T20:00:00.000Z');
  });

  it('NO tenant timezone → the spoken time stays UNRESOLVED (explicit refusal downstream, never silent UTC)', async () => {
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'create_appointment',
      { dateTimeDescription: 'Thursday at 2pm' },
    );
    expect(res.status).toBe('resolved');
    expect(res.refs.scheduledStart).toBeUndefined();
    expect(res.refs.scheduledEnd).toBeUndefined();
  });

  it('an INVALID timezone is treated as unconfigured — never falls back to a default zone', async () => {
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'create_appointment',
      { dateTimeDescription: 'Thursday at 2pm' },
      undefined,
      { timezone: 'Not/AZone', now: NOW },
    );
    expect(res.refs.scheduledStart).toBeUndefined();
  });

  it('reschedule\'s newDateTimeDescription takes the same tenant-zone path', async () => {
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'reschedule_appointment',
      { appointmentReference: 'APT-1', newDateTimeDescription: 'Thursday at 2pm' },
      undefined,
      { timezone: TZ, now: NOW },
    );
    expect(res.refs.newScheduledStart).toBe('2026-08-06T19:00:00.000Z');

    const noTz = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'reschedule_appointment',
      { appointmentReference: 'APT-1', newDateTimeDescription: 'Thursday at 2pm' },
    );
    expect(noTz.refs.newScheduledStart).toBeUndefined();
  });

  it('unparseable text never guesses, even with a timezone', async () => {
    const res = await resolveSchedulingEntities(
      undefined,
      'tenant-1',
      'create_appointment',
      { dateTimeDescription: 'whenever works for you' },
      undefined,
      { timezone: TZ, now: NOW },
    );
    expect(res.refs.scheduledStart).toBeUndefined();
  });
});

describe('planVoiceEntityLookups — intent-conditioned operator references', () => {
  it('routes INV-0042 jobReference to invoice lookup for update_invoice', () => {
    const lookups = planVoiceEntityLookups('update_invoice', { jobReference: 'INV-0042' });
    expect(lookups).toEqual([
      { kind: 'invoice', reference: 'INV-0042', refKey: 'invoiceId' },
    ]);
  });

  it('routes EST-0042 jobReference to estimate lookup for update_estimate', () => {
    const lookups = planVoiceEntityLookups('update_estimate', { jobReference: 'EST-0042' });
    expect(lookups).toEqual([
      { kind: 'estimate', reference: 'EST-0042', refKey: 'estimateId' },
    ]);
  });

  it('resolves Khan customer name for lookup_customer', () => {
    const lookups = planVoiceEntityLookups('lookup_customer', { customerName: 'Khan' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Khan', refKey: 'customerId' },
    ]);
  });

  // "Nudge the Khan estimate" resolves a PERSON. Without send_estimate_nudge
  // in CUSTOMER_REF_INTENTS the router planned no lookup at all, so the task
  // handler had nothing but display text (estimate_number/customer_message)
  // to ILIKE and could never reach the customer's estimates.
  it('resolves the spoken customer name for send_estimate_nudge', () => {
    const lookups = planVoiceEntityLookups('send_estimate_nudge', { customerName: 'Khan' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Khan', refKey: 'customerId' },
    ]);
  });

  it('still routes a spoken estimate NUMBER to the estimate lookup for send_estimate_nudge', () => {
    const lookups = planVoiceEntityLookups('send_estimate_nudge', {
      customerName: 'Khan',
      jobReference: 'EST-0042',
    });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Khan', refKey: 'customerId' },
      { kind: 'estimate', reference: 'EST-0042', refKey: 'estimateId' },
    ]);
  });

  it('resolves Henderson customer name for lookup_balance', () => {
    const lookups = planVoiceEntityLookups('lookup_balance', { customerName: 'Henderson' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Henderson', refKey: 'customerId' },
    ]);
  });

  it('resolves Garcia Tuesday appointment reference for reschedule_appointment', () => {
    const lookups = planVoiceEntityLookups('reschedule_appointment', {
      appointmentReference: 'Tuesday',
    });
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'Tuesday', refKey: 'appointmentId' },
    ]);
  });

  it('resolves Carlos technician name for reassign_appointment', () => {
    const lookups = planVoiceEntityLookups('reassign_appointment', {
      targetTechnicianName: 'Carlos',
    });
    expect(lookups).toEqual([
      { kind: 'technician', reference: 'Carlos', refKey: 'technicianId' },
    ]);
  });

  it('create_customer never pre-resolves a customer name', () => {
    const lookups = planVoiceEntityLookups('create_customer', {
      customerName: 'New Person',
      displayName: 'New Person',
    });
    expect(lookups).toEqual([]);
  });

  // U2 (B7.10) — crew add/remove joined APPOINTMENT_REF_INTENTS: "add Jake
  // to the 2pm tomorrow" plans BOTH the technician lookup (U1) and the
  // appointment lookup (same order as reassign: technician before
  // appointment, so the picker asks WHICH Jake before WHICH appointment).
  it('plans technician + appointment lookups for add_crew_member', () => {
    const lookups = planVoiceEntityLookups('add_crew_member', {
      targetTechnicianName: 'Jake',
      appointmentReference: 'the 2pm tomorrow',
    });
    expect(lookups).toEqual([
      { kind: 'technician', reference: 'Jake', refKey: 'technicianId' },
      { kind: 'appointment', reference: 'the 2pm tomorrow', refKey: 'appointmentId' },
    ]);
  });

  // U3 (B7.8) — "$40 in parts for the Henderson job": log_expense joined
  // JOB_REF_INTENTS so the spoken job reference resolves to a jobId and the
  // expense keeps its P&L link.
  it('plans a job lookup for log_expense', () => {
    const lookups = planVoiceEntityLookups('log_expense', {
      jobReference: 'the Henderson job',
    });
    expect(lookups).toEqual([
      { kind: 'job', reference: 'the Henderson job', refKey: 'jobId' },
    ]);
  });

  it('plans technician + appointment lookups for remove_crew_member (no sticky-job fallback)', () => {
    const lookups = planVoiceEntityLookups(
      'remove_crew_member',
      { targetTechnicianName: 'Jake', appointmentReference: "Tuesday's job" },
      'sticky-job-1',
    );
    // Crew intents are deliberately NOT in APPOINTMENT_JOB_FALLBACK_INTENTS,
    // so the sticky jobId never rides the appointment lookup here.
    expect(lookups).toEqual([
      { kind: 'technician', reference: 'Jake', refKey: 'technicianId' },
      { kind: 'appointment', reference: "Tuesday's job", refKey: 'appointmentId' },
    ]);
  });
});

// SCH-03 — "cancel the upcoming appointment for that job" fails to parse as a
// date; cancel/reschedule/reassign_appointment fall back to the sticky
// context.jobId from an earlier turn. confirm_appointment does NOT get the
// fallback (no "for that job" phrasing in the corpus).
describe('planVoiceEntityLookups — SCH-03 job-scoped appointment fallback', () => {
  it('attaches stickyJobId to the appointment lookup for cancel_appointment', () => {
    const lookups = planVoiceEntityLookups(
      'cancel_appointment',
      { appointmentReference: 'that job' },
      'job-42',
    );
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'that job', refKey: 'appointmentId', jobId: 'job-42' },
    ]);
  });

  it('attaches stickyJobId for reschedule_appointment', () => {
    const lookups = planVoiceEntityLookups(
      'reschedule_appointment',
      { appointmentReference: 'that job' },
      'job-42',
    );
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'that job', refKey: 'appointmentId', jobId: 'job-42' },
    ]);
  });

  it('attaches stickyJobId for reassign_appointment', () => {
    const lookups = planVoiceEntityLookups(
      'reassign_appointment',
      { appointmentReference: 'that job' },
      'job-42',
    );
    expect(lookups[0]).toMatchObject({ kind: 'appointment', jobId: 'job-42' });
  });

  it('does NOT attach stickyJobId for confirm_appointment (not in the fallback set)', () => {
    const lookups = planVoiceEntityLookups(
      'confirm_appointment',
      { appointmentReference: 'that job' },
      'job-42',
    );
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'that job', refKey: 'appointmentId' },
    ]);
  });

  it('omits jobId entirely when no stickyJobId is supplied (unchanged shape)', () => {
    const lookups = planVoiceEntityLookups('cancel_appointment', {
      appointmentReference: 'Tuesday',
    });
    expect(lookups).toEqual([
      { kind: 'appointment', reference: 'Tuesday', refKey: 'appointmentId' },
    ]);
  });
});

describe('resolveSchedulingEntities — SCH-03 job fallback chain', () => {
  function resolverThatOnlySucceedsWithJobId(expectedJobId: string): EntityResolver {
    return {
      resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
        if (input.kind === 'appointment' && input.jobId === expectedJobId) {
          return {
            kind: 'resolved',
            candidate: { id: 'appt-from-job', kind: 'appointment', label: '2026-08-01', score: 1 },
          };
        }
        return { kind: 'not_found', reference: input.reference };
      }),
    };
  }

  it('resolves the appointment via stickyJobId when appointmentReference is not a date phrase', async () => {
    const resolver = resolverThatOnlySucceedsWithJobId('job-42');
    const res = await resolveSchedulingEntities(
      resolver,
      'tenant-1',
      'cancel_appointment',
      { appointmentReference: 'that job' },
      'job-42',
    );
    expect(res.status).toBe('resolved');
    expect(res.refs.appointmentId).toBe('appt-from-job');
  });

  it('without a stickyJobId, the same non-date reference falls through to not_found', async () => {
    const resolver = resolverThatOnlySucceedsWithJobId('job-42');
    const res = await resolveSchedulingEntities(
      resolver,
      'tenant-1',
      'cancel_appointment',
      { appointmentReference: 'that job' },
      // no stickyJobId
    );
    expect(res.status).toBe('not_found');
  });
});

describe('resolveVoiceEntityReferences — router annotation folding', () => {
  const TID = 'tenant-voice';

  function resolverWith(results: Record<string, EntityResolverResult>): EntityResolver {
    return {
      resolve: vi.fn(async (input) => {
        const key = `${input.kind}:${input.reference}`;
        return results[key] ?? { kind: 'not_found', reference: input.reference };
      }),
    };
  }

  it('unique invoice match stamps invoiceId on the annotation', async () => {
    const resolver = resolverWith({
      'invoice:INV-0042': {
        kind: 'resolved',
        candidate: { id: 'inv-42', kind: 'invoice', label: 'INV-0042', score: 1 },
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'update_invoice',
      entities: { jobReference: 'INV-0042' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBe('inv-42');
      expect(result.pendingReferences).toEqual([]);
    }
  });

  it('two Smith-like customer matches → ambiguous clarification', async () => {
    const resolver = resolverWith({
      'customer:Smith': {
        kind: 'ambiguous',
        candidates: [
          { id: 'smith-a', kind: 'customer', label: 'John Smith', score: 0.9 },
          { id: 'smith-b', kind: 'customer', label: 'Jane Smith', score: 0.88 },
        ],
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'create_invoice',
      entities: { customerName: 'Smith' },
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.entityKind).toBe('customer');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('unknown customer becomes pendingReference instead of blocking', async () => {
    const resolver = resolverWith({});
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'create_invoice',
      entities: { customerName: 'Ghost Customer' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.customerId).toBeUndefined();
      expect(result.pendingReferences).toEqual([
        { kind: 'customer', reference: 'Ghost Customer' },
      ]);
    }
  });
});
