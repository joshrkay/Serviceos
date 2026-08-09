/**
 * Task 10 residual (two re-reviews, both "ship") — a DIRECT unit test on
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
import { describe, it, expect } from 'vitest';
import { executeLookupAnswer } from '../../src/workers/voice-lookup-answer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import type { Job } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import type { Appointment } from '../../src/appointments/appointment';
import { InMemoryUserRepository } from '../../src/users/user';
import { InMemoryProposalRepository } from '../../src/proposals/proposal';

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
