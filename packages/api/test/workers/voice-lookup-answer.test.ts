/**
 * Task 10 (2026-08-07 tradesperson plan) residual (two re-reviews, both
 * "ship") — a DIRECT unit test on
 * `executeLookupAnswer`'s `lookup_my_day` case.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The chat-surface tests (test/routes/assistant-lookup-dispatch.test.ts)
 * assert `entityResolver.resolve` is never called for `lookup_my_day` —
 * that pins the SURFACE gate (`lookup_my_day` is absent from
 * `TECHNICIAN_REF_INTENTS`, so `dispatchAssistantLookup` never resolves a
 * spoken name into `input.technicianId` in the first place). It does NOT
 * exercise the actual discard: nothing anywhere passed `technicianId`
 * alongside `intent: 'lookup_my_day'` into `executeLookupAnswer` itself,
 * so the case body's silent disregard of that field — the single most
 * load-bearing line in the whole Task 10 change, per the module doc
 * comment above the `lookup_my_day` case in
 * `src/workers/voice-lookup-answer.ts` — was never actually pinned.
 *
 * This test calls `executeLookupAnswer` directly with a `technicianId`
 * that WOULD resolve to a real, different technician's real appointment,
 * proving the case body ignores it and always self-scopes to the
 * `actorId`-resolved SPEAKER, independent of whichever surface gate
 * (chat's TECHNICIAN_REF_INTENTS, the memo worker's own dispatch) happens
 * to guard the field upstream.
 */
import { describe, it, expect, vi } from 'vitest';
import { executeLookupAnswer } from '../../src/workers/voice-lookup-answer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';
import { InMemoryCustomerRepository } from '../../src/customers/customer';

const TENANT = 'tenant-1';
const TZ = 'America/New_York';
// 2026-06-11 ~07:00 New York (11:00 UTC).
const NOW = new Date('2026-06-11T11:00:00.000Z');
const ACTOR_CLERK_ID = 'clerk-actor';

function makeJob(over: Partial<Job>): Job {
  return {
    id: `job-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    customerId: 'cust-1',
    locationId: 'loc-1',
    jobNumber: 'JOB-0001',
    summary: 'Untitled job',
    status: 'scheduled',
    priority: 'normal',
    createdBy: 'u1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  } as Job;
}

function makeAppointment(over: Partial<Appointment>): Appointment {
  return {
    id: `appt-${Math.random().toString(36).slice(2, 8)}`,
    tenantId: TENANT,
    jobId: 'job-1',
    scheduledStart: new Date('2026-06-11T13:00:00.000Z'), // 9am NY
    scheduledEnd: new Date('2026-06-11T15:00:00.000Z'),
    timezone: TZ,
    status: 'scheduled',
    holdPendingApproval: false,
    createdBy: 'u1',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

describe('executeLookupAnswer — lookup_my_day discards a resolved technicianId', () => {
  it('answers with the ACTOR\'s own day even when technicianId names a DIFFERENT, resolvable technician', async () => {
    const userRepo = new InMemoryUserRepository();
    await userRepo.create({
      id: 'actor-internal-id',
      tenantId: TENANT,
      clerkUserId: ACTOR_CLERK_ID,
      email: 'actor@example.com',
      role: 'technician',
      firstName: 'Actor',
      lastName: 'Self',
      canFieldServe: true,
    });
    await userRepo.create({
      id: 'someone-else-id',
      tenantId: TENANT,
      email: 'someone@example.com',
      role: 'technician',
      firstName: 'Someone',
      lastName: 'Else',
      canFieldServe: true,
    });

    const jobRepo = new InMemoryJobRepository();
    const actorJob = makeJob({
      id: 'job-actor',
      summary: "Actor's own job",
      assignedTechnicianId: 'actor-internal-id',
    });
    const otherJob = makeJob({
      id: 'job-other',
      summary: "Someone else's job",
      assignedTechnicianId: 'someone-else-id',
    });
    await jobRepo.create(actorJob);
    await jobRepo.create(otherJob);

    const appointmentRepo = new InMemoryAppointmentRepository();
    await appointmentRepo.create(makeAppointment({ id: 'appt-actor', jobId: 'job-actor' }));
    await appointmentRepo.create(makeAppointment({ id: 'appt-other', jobId: 'job-other' }));

    // A real, resolvable technicianId — NOT a not_found/unresolvable
    // placeholder — so a test that merely proved "the discard didn't
    // crash on garbage" couldn't pass for the wrong reason.
    const execution = await executeLookupAnswer(
      {
        tenantId: TENANT,
        sessionId: 'sess-1',
        intent: 'lookup_my_day',
        actorId: ACTOR_CLERK_ID,
        technicianId: 'someone-else-id',
        timezone: TZ,
        now: NOW,
      },
      {},
      { jobRepo, appointmentRepo, userRepo, proposalRepo: new InMemoryProposalRepository() },
    );

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') throw new Error('unreachable');
    expect(execution.answer.summary).toContain("Actor's own job");
    expect(execution.answer.summary).not.toContain("Someone else's job");
  });
});

/**
 * #866 — `lookup_pending_items` speaks the dropped-call recoveries bucket on
 * EVERY surface.
 *
 * The phone's deleted switch (`ai/voice-turn/lookup-skill-runner.ts`) passed
 * `listUnansweredRecoveries` to the skill; the shared dispatch did not, so
 * routing the phone through it would have silently dropped that line from the
 * one surface that had it. The port belongs on the shared deps, not on a
 * surface adapter.
 */
describe('executeLookupAnswer — lookup_pending_items recoveries port', () => {
  it('threads droppedCallRecoveryRepo through to the skill', async () => {
    const listUnansweredRecoveries = vi.fn(async () => []);
    const execution = await executeLookupAnswer(
      {
        tenantId: 't1',
        sessionId: '00000000-0000-4000-8000-000000000001',
        intent: 'lookup_pending_items',
        actorId: 'owner-1',
        now: new Date(),
      },
      {
        // lookup-pending-items.ts reads sent estimates and open /
        // partially_paid invoices off findByTenant.
        estimateRepo: { findByTenant: vi.fn(async () => []) } as never,
        invoiceRepo: { findByTenant: vi.fn(async () => []) } as never,
        droppedCallRecoveryRepo: { listUnansweredRecoveries },
        resolveMemberRole: async () => 'owner',
      },
      { proposalRepo: new InMemoryProposalRepository() },
    );

    expect(execution.kind).toBe('answer');
    expect(listUnansweredRecoveries).toHaveBeenCalledWith('t1');
  });
});

/**
 * #869 — the answer's SUBSTANCE must survive an entity id the client-side
 * deep-link schema rejects.
 *
 * `VoiceAnswerEntityRef.id` is `z.string().uuid()`, and `buildAnswer` parses
 * (never casts) the whole answer — so a non-UUID id used to throw INSIDE the
 * dispatch's try block and surface as `{kind:'failed'}`. On the phone the
 * entityRef is discarded entirely, so a caller whose lookup succeeded would
 * instead hear "let me get a person to help"; on chat/memo a correct, already
 * computed answer would be stored as `answer_status='failed'`. The optional
 * deep-link is the only thing that may degrade.
 *
 * Found by routing the Layer 1 harness through this dispatch (#869): its
 * corpus fixtures carry readable ids (`cust_01_…`), not UUIDs.
 */
describe('executeLookupAnswer — a non-UUID entity id degrades the deep-link, not the answer', () => {
  it('answers lookup_customer for a non-UUID customerId, dropping only entityRef.id', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    await customerRepo.create({
      id: 'cust_01_customer_carlos',
      tenantId: TENANT,
      firstName: 'Carlos',
      lastName: 'Rivera',
      displayName: 'Carlos Rivera',
      primaryPhone: '+15555550102',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: 'user_seed',
      createdAt: new Date('2026-02-10T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:00:00.000Z'),
    });

    const execution = await executeLookupAnswer(
      {
        tenantId: TENANT,
        sessionId: '00000000-0000-4000-8000-000000000002',
        intent: 'lookup_customer',
        customerId: 'cust_01_customer_carlos',
        now: NOW,
      },
      {},
      { proposalRepo: new InMemoryProposalRepository(), customerRepo },
    );

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') return;
    expect(execution.answer.result).toBe('found');
    expect(execution.answer.summary).toContain('Carlos');
    // The kind survives (it tells the client WHAT was answered about); the
    // unusable id does not.
    expect(execution.answer.entityRef).toEqual({ kind: 'customer' });
  });

  it('keeps a well-formed UUID entity id', async () => {
    const customerRepo = new InMemoryCustomerRepository();
    const id = '11111111-1111-4111-8111-111111111111';
    await customerRepo.create({
      id,
      tenantId: TENANT,
      firstName: 'Uma',
      lastName: 'Uuid',
      displayName: 'Uma Uuid',
      primaryPhone: '+15555550103',
      preferredChannel: 'phone',
      smsConsent: true,
      isArchived: false,
      createdBy: 'user_seed',
      createdAt: new Date('2026-02-10T09:00:00.000Z'),
      updatedAt: new Date('2026-04-01T09:00:00.000Z'),
    });

    const execution = await executeLookupAnswer(
      {
        tenantId: TENANT,
        sessionId: '00000000-0000-4000-8000-000000000003',
        intent: 'lookup_customer',
        customerId: id,
        now: NOW,
      },
      {},
      { proposalRepo: new InMemoryProposalRepository(), customerRepo },
    );

    expect(execution.kind).toBe('answer');
    if (execution.kind !== 'answer') return;
    expect(execution.answer.entityRef).toEqual({ kind: 'customer', id });
  });
});
