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

  // Tradesperson wave 1, Task 3 — record_refund joins INVOICE_DOC_INTENTS
  // the same way record_payment does: there is no separate
  // `invoiceReference` extraction field anywhere in this taxonomy, so the
  // spoken invoice reference rides `jobReference` and is disambiguated by
  // intent-set membership alone.
  it('routes a jobReference to invoice lookup for record_refund', () => {
    const lookups = planVoiceEntityLookups('record_refund', { jobReference: 'INV-0099' });
    expect(lookups).toEqual([
      { kind: 'invoice', reference: 'INV-0099', refKey: 'invoiceId' },
    ]);
  });

  // Tradesperson wave 1, Task 4 — apply_credit joins INVOICE_DOC_INTENTS the
  // same way record_refund does: no separate invoiceReference field exists,
  // so the spoken invoice reference rides jobReference.
  it('routes a jobReference to invoice lookup for apply_credit', () => {
    const lookups = planVoiceEntityLookups('apply_credit', { jobReference: 'the Henderson invoice' });
    expect(lookups).toEqual([
      { kind: 'invoice', reference: 'the Henderson invoice', refKey: 'invoiceId' },
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

  // Tradesperson wave 1, Task 5 — a spoken "text/email the Hendersons..."
  // names a PERSON, not display text. Mirrors send_estimate_nudge's
  // rationale above.
  it('resolves the spoken customer name for send_customer_message', () => {
    const lookups = planVoiceEntityLookups('send_customer_message', { customerName: 'Henderson' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Henderson', refKey: 'customerId' },
    ]);
  });

  // Task 7 (2026-08-07 tradesperson plan) — "sign the Garcias up for the
  // annual maintenance plan" names a PERSON, not display text. Mirrors
  // send_customer_message's rationale above.
  it('resolves the spoken customer name for create_service_agreement', () => {
    const lookups = planVoiceEntityLookups('create_service_agreement', { customerName: 'Garcia' });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Garcia', refKey: 'customerId' },
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

  // Task 9 (2026-08-07 tradesperson plan) — "grab three boxes of PEX for
  // the Patel job" joins JOB_REF_INTENTS the same way log_expense does, so
  // the spoken job reference resolves to a jobId and the captured material
  // keeps its job link. jobId stays OPTIONAL on the contract — an
  // unresolved reference never gates — but a NAMED job still resolves.
  it('plans a job lookup for add_material', () => {
    const lookups = planVoiceEntityLookups('add_material', {
      jobReference: 'the Patel job',
    });
    expect(lookups).toEqual([
      { kind: 'job', reference: 'the Patel job', refKey: 'jobId' },
    ]);
  });

  // Task 9 — lookup_materials joins JOB_REF_INTENTS the SAME way so the
  // shopping-list readback can scope to one job ("what materials are open
  // on the Patel job?"). Read-only — no gating implications.
  it('plans a job lookup for lookup_materials', () => {
    const lookups = planVoiceEntityLookups('lookup_materials', {
      jobReference: 'the Patel job',
    });
    expect(lookups).toEqual([
      { kind: 'job', reference: 'the Patel job', refKey: 'jobId' },
    ]);
  });

  // Task 10 (2026-08-07 tradesperson plan) — lookup_crew_schedule/
  // lookup_timesheets join TECHNICIAN_REF_INTENTS the SAME way
  // reassign_appointment does, so a named crew member ("What's Mike's day
  // look like?") resolves to a verified technicianId before either skill
  // runs. An unresolved name is refused by the caller
  // (workers/voice-lookup-answer.ts), never silently widened to the whole
  // crew.
  it('resolves a named crew member for lookup_crew_schedule', () => {
    const lookups = planVoiceEntityLookups('lookup_crew_schedule', {
      targetTechnicianName: 'Mike',
    });
    expect(lookups).toEqual([{ kind: 'technician', reference: 'Mike', refKey: 'technicianId' }]);
  });

  it('lookup_crew_schedule with no named crew member plans no lookups (whole-crew ask)', () => {
    const lookups = planVoiceEntityLookups('lookup_crew_schedule', {
      dateTimeDescription: 'Thursday afternoon',
    });
    expect(lookups).toEqual([]);
  });

  it('resolves a named crew member for lookup_timesheets', () => {
    const lookups = planVoiceEntityLookups('lookup_timesheets', {
      targetTechnicianName: 'Carlos',
    });
    expect(lookups).toEqual([{ kind: 'technician', reference: 'Carlos', refKey: 'technicianId' }]);
  });

  it('lookup_timesheets with no named crew member plans no lookups (whole-crew ask)', () => {
    const lookups = planVoiceEntityLookups('lookup_timesheets', {});
    expect(lookups).toEqual([]);
  });

  // lookup_my_day is deliberately absent from TECHNICIAN_REF_INTENTS — it
  // is self-scoped to the SPEAKER via resolveCanonicalUser
  // (dispatch/en-route-voice.ts), never a spoken/resolved reference.
  it('lookup_my_day never plans a technician lookup — it is self-scoped, not reference-scoped', () => {
    const lookups = planVoiceEntityLookups('lookup_my_day', {
      targetTechnicianName: 'Mike',
    });
    expect(lookups).toEqual([]);
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

  // Tradesperson wave 1 (2026-08-07 plan) — aliases resolve the same refs as
  // their targets. schedule_inspection joined BOTH CUSTOMER_REF_INTENTS and
  // JOB_REF_INTENTS (it books a visit on an existing job for a known
  // customer), customer-before-job per the family's standard ordering.
  it('plans customer + job lookups for schedule_inspection', () => {
    const lookups = planVoiceEntityLookups('schedule_inspection', {
      customerName: 'Patel',
      jobReference: 'the Patel job',
    });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Patel', refKey: 'customerId' },
      { kind: 'job', reference: 'the Patel job', refKey: 'jobId' },
    ]);
  });

  // Spec-review fix (2026-08-07) — schedule_inspection's jobTitle carries
  // DESCRIPTIVE text ("Inspection — rough-in"), never an existing-job name.
  // Before this fix, the JOB_REF_INTENTS fallback (jobReference ?? jobTitle,
  // see the comment above the fallback in entity-resolution.ts) misread it
  // as a lookup key, which would search for a job literally titled
  // "Inspection — rough-in" — a job that was never meant to exist by that
  // name. Because requiresExistingEntity('schedule_inspection') is TRUE
  // (e255bbc0, deliberate — an inspection needs its named job to actually
  // exist), that bogus not_found would wrongly escalate an inspection that
  // never named a job at all. jobTitle must never be used as a lookup key
  // for this intent; only an explicit jobReference may.
  it('does NOT plan a job lookup from jobTitle when no jobReference is spoken', () => {
    const lookups = planVoiceEntityLookups('schedule_inspection', {
      customerName: 'Patel',
      dateTimeDescription: 'Thursday',
      jobTitle: 'Inspection — rough-in',
      // no jobReference
    });
    expect(lookups).toEqual([{ kind: 'customer', reference: 'Patel', refKey: 'customerId' }]);
  });

  it('plans a job lookup for log_permit', () => {
    const lookups = planVoiceEntityLookups('log_permit', {
      jobReference: 'the Patel job',
    });
    expect(lookups).toEqual([
      { kind: 'job', reference: 'the Patel job', refKey: 'jobId' },
    ]);
  });

  // Quality-review fix (2026-08-08) — log_permit ALSO joined
  // CUSTOMER_REF_INTENTS: its target, add_note, already resolves
  // customerName (a note can target a customer, not just a job — see
  // NOTE_TARGET_KINDS), so a permit note naming a customer rather than a
  // job ("Note the electrical permit was approved for the Hendersons")
  // must resolve the same way a plain add_note would. Before this fix that
  // customer reference stayed unresolved and fully manual.
  it('plans a customer lookup for log_permit when a customer, not a job, is named', () => {
    const lookups = planVoiceEntityLookups('log_permit', {
      customerName: 'Henderson',
    });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Henderson', refKey: 'customerId' },
    ]);
  });

  it('plans customer + job lookups for log_permit when both are named, customer first', () => {
    const lookups = planVoiceEntityLookups('log_permit', {
      customerName: 'Patel',
      jobReference: 'the Patel job',
    });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Patel', refKey: 'customerId' },
      { kind: 'job', reference: 'the Patel job', refKey: 'jobId' },
    ]);
  });

  // log_warranty_claim joined CUSTOMER_REF_INTENTS only — it aliases
  // create_job, which resolves a customer, not an existing job reference.
  it('plans a customer lookup for log_warranty_claim', () => {
    const lookups = planVoiceEntityLookups('log_warranty_claim', {
      customerName: 'Henderson',
    });
    expect(lookups).toEqual([
      { kind: 'customer', reference: 'Henderson', refKey: 'customerId' },
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

// Spec-review fix (2026-08-07) — schedule_inspection mirrors create_appointment
// on the entity-resolution axis this plan didn't originally cover: jobTitle
// is descriptive text, never a job-lookup key. requiresExistingEntity stays
// TRUE for this intent (e255bbc0, deliberate — a NAMED job must actually
// exist), so the fix is narrower than "never require an existing job": it is
// "never attempt a job lookup the caller never asked for."
describe('resolveSchedulingEntities — schedule_inspection descriptive jobTitle', () => {
  it('proceeds with no job link when no job is named — the resolver is never asked to look up a job', async () => {
    const resolver: EntityResolver = {
      resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
        if (input.kind === 'job') {
          throw new Error('must never look up a job keyed on descriptive jobTitle text');
        }
        return {
          kind: 'resolved',
          candidate: { id: 'cust-1', kind: 'customer', label: 'Patel', score: 1 },
        };
      }),
    };
    const res = await resolveSchedulingEntities(resolver, 'tenant-1', 'schedule_inspection', {
      customerName: 'Patel',
      dateTimeDescription: 'Thursday',
      jobTitle: 'Inspection — rough-in',
      // no jobReference
    });
    // Not a not_found escalation (VOX-02/inapp-adapter.ts) — the resolver
    // was never asked about a job at all, so there is nothing to escalate.
    expect(res.status).toBe('resolved');
    expect(res.refs.customerId).toBe('cust-1');
    expect(res.refs.jobId).toBeUndefined();
  });

  it('still resolves jobId when an existing job is explicitly named ("the Patel job")', async () => {
    const resolver: EntityResolver = {
      resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
        if (input.kind === 'job' && input.reference === 'the Patel job') {
          return {
            kind: 'resolved',
            candidate: { id: 'job-77', kind: 'job', label: 'Patel Repair', score: 1 },
          };
        }
        if (input.kind === 'customer') {
          return {
            kind: 'resolved',
            candidate: { id: 'cust-1', kind: 'customer', label: 'Patel', score: 1 },
          };
        }
        return { kind: 'not_found', reference: input.reference };
      }),
    };
    const res = await resolveSchedulingEntities(resolver, 'tenant-1', 'schedule_inspection', {
      customerName: 'Patel',
      jobReference: 'the Patel job',
      jobTitle: 'Inspection — rough-in',
      dateTimeDescription: 'Thursday',
    });
    expect(res.status).toBe('resolved');
    expect(res.refs.jobId).toBe('job-77');
    expect(res.refs.customerId).toBe('cust-1');
  });

  it('a NAMED job that does not exist still escalates (requiresExistingEntity stays TRUE)', async () => {
    const resolver: EntityResolver = {
      resolve: vi.fn(async (input): Promise<EntityResolverResult> => {
        if (input.kind === 'customer') {
          return {
            kind: 'resolved',
            candidate: { id: 'cust-1', kind: 'customer', label: 'Patel', score: 1 },
          };
        }
        return { kind: 'not_found', reference: input.reference };
      }),
    };
    const res = await resolveSchedulingEntities(resolver, 'tenant-1', 'schedule_inspection', {
      customerName: 'Patel',
      jobReference: 'the nonexistent job',
      jobTitle: 'Inspection — rough-in',
    });
    // An EXPLICIT reference that fails to resolve is a real not_found — the
    // fallback exclusion only covers jobTitle, never a spoken jobReference.
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

  // Tradesperson wave 1, Task 3 — record_refund plugs into the SAME
  // generic annotation pipeline record_payment uses: unique match resolves,
  // ambiguous match clarifies, zero match leaves invoiceId absent (never a
  // silent guess) so RecordRefundTaskHandler gates on missingFields.
  it('record_refund: unique invoice match stamps invoiceId on the annotation', async () => {
    const resolver = resolverWith({
      'invoice:INV-0099': {
        kind: 'resolved',
        candidate: { id: 'inv-99', kind: 'invoice', label: 'INV-0099', score: 1 },
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'record_refund',
      entities: { jobReference: 'INV-0099' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBe('inv-99');
    }
  });

  it('record_refund: an ambiguous invoice reference becomes a clarification, never a guess', async () => {
    const resolver = resolverWith({
      'invoice:the Smith invoice': {
        kind: 'ambiguous',
        candidates: [
          { id: 'inv-a', kind: 'invoice', label: 'INV-0010 (Smith)', score: 0.85 },
          { id: 'inv-b', kind: 'invoice', label: 'INV-0031 (Smith)', score: 0.82 },
        ],
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'record_refund',
      entities: { jobReference: 'the Smith invoice' },
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.entityKind).toBe('invoice');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('record_refund: a zero-match invoice reference leaves invoiceId absent (never silently guessed)', async () => {
    const resolver = resolverWith({});
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'record_refund',
      entities: { jobReference: 'INV-9999' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBeUndefined();
    }
  });

  // Tradesperson wave 1, Task 4 — apply_credit plugs into the SAME generic
  // annotation pipeline record_refund/record_payment use.
  it('apply_credit: unique invoice match stamps invoiceId on the annotation', async () => {
    const resolver = resolverWith({
      'invoice:the Henderson invoice': {
        kind: 'resolved',
        candidate: { id: 'inv-henderson', kind: 'invoice', label: 'INV-0100 (Henderson)', score: 1 },
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'apply_credit',
      entities: { jobReference: 'the Henderson invoice' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBe('inv-henderson');
    }
  });

  it('apply_credit: an ambiguous invoice reference becomes a clarification, never a guess', async () => {
    const resolver = resolverWith({
      'invoice:the Smith invoice': {
        kind: 'ambiguous',
        candidates: [
          { id: 'inv-a', kind: 'invoice', label: 'INV-0010 (Smith)', score: 0.85 },
          { id: 'inv-b', kind: 'invoice', label: 'INV-0031 (Smith)', score: 0.82 },
        ],
      },
    });
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'apply_credit',
      entities: { jobReference: 'the Smith invoice' },
    });
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.entityKind).toBe('invoice');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('apply_credit: a zero-match invoice reference leaves invoiceId absent (never silently guessed)', async () => {
    const resolver = resolverWith({});
    const result = await resolveVoiceEntityReferences(resolver, {
      tenantId: TID,
      intent: 'apply_credit',
      entities: { jobReference: 'INV-9999' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.resolved.invoiceId).toBeUndefined();
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
