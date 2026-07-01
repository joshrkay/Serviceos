/**
 * U2 — job-appointment-sync. Pins the projection of a job's schedule intent
 * onto the canonical appointment (+ primary assignment) against in-memory
 * repos. The real Postgres atomicity / constraint behavior is pinned
 * separately in test/integration/job-appointment-sync.test.ts (mocks can't
 * prove the unique index or no_double_booking EXCLUDE).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Job, InMemoryJobRepository, createJob, getJob } from '../../src/jobs/job';
import {
  InMemoryAppointmentRepository,
  createAppointment,
} from '../../src/appointments/appointment';
import { InMemoryAssignmentRepository } from '../../src/appointments/assignment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { InMemoryJobTimelineRepository, transitionJobStatus } from '../../src/jobs/job-lifecycle';
import { User, UserRepository } from '../../src/users/user';
import { ConflictError, ValidationError } from '../../src/shared/errors';
import {
  JobAppointmentSyncDeps,
  jobScheduleKey,
  syncJobSchedule,
} from '../../src/jobs/job-appointment-sync';

const TENANT = uuidv4();
const TECH_1 = uuidv4();
const TECH_2 = uuidv4();
const NOW = new Date('2026-06-10T00:00:00Z');
const START = new Date('2030-07-01T15:00:00.000Z');
const NEW_START = new Date('2030-07-02T15:00:00.000Z');

function tech(id: string): User {
  return { id, tenantId: TENANT, email: `${id}@x.com`, role: 'technician', canFieldServe: true, createdAt: NOW, updatedAt: NOW };
}
function dispatcher(id: string): User {
  return { id, tenantId: TENANT, email: `${id}@x.com`, role: 'dispatcher', canFieldServe: true, createdAt: NOW, updatedAt: NOW };
}

function fakeUserRepo(users: User[]): UserRepository {
  return {
    findByTenant: async (t, opts) =>
      users.filter((u) => u.tenantId === t && (!opts?.role || u.role === opts.role)).map((u) => ({ ...u })),
    findById: async (t, id) => users.find((u) => u.tenantId === t && u.id === id) ?? null,
    findByMobileNumber: async () => null,
    setMobileNumber: async () => null,
    update: async () => null,
  };
}

describe('U2 — syncJobSchedule', () => {
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let assignmentRepo: InMemoryAssignmentRepository;
  let timelineRepo: InMemoryJobTimelineRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    assignmentRepo = new InMemoryAssignmentRepository();
    timelineRepo = new InMemoryJobTimelineRepository();
    auditRepo = new InMemoryAuditRepository();
  });

  function deps(users: User[]): JobAppointmentSyncDeps {
    return { jobRepo, appointmentRepo, assignmentRepo, userRepo: fakeUserRepo(users), timelineRepo, auditRepo };
  }

  async function newJob(): Promise<Job> {
    return createJob(
      { tenantId: TENANT, customerId: uuidv4(), locationId: uuidv4(), summary: 'Fix sink', createdBy: 'owner-1', actorRole: 'owner' },
      jobRepo,
      auditRepo,
    );
  }

  function scheduleInput(jobId: string, over: Partial<{ scheduledStart: Date; technicianId: string }> = {}) {
    return {
      operation: 'schedule' as const,
      tenantId: TENANT,
      jobId,
      actorId: 'owner-1',
      actorRole: 'owner',
      scheduledStart: over.scheduledStart ?? START,
      technicianId: 'technicianId' in over ? over.technicianId : TECH_1,
      durationMin: 60,
    };
  }

  async function activeAppointments(jobId: string) {
    return (await appointmentRepo.findByJob(TENANT, jobId)).filter((a) => a.status !== 'canceled');
  }

  it('schedules a new job: one appointment + primary assignment, job advances new → scheduled', async () => {
    const job = await newJob();
    const res = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));

    expect(res.appointment).not.toBeNull();
    expect(res.appointment!.idempotencyKey).toBe(jobScheduleKey(job.id));
    expect(await activeAppointments(job.id)).toHaveLength(1);

    const assignments = await assignmentRepo.findByAppointment(TENANT, res.appointment!.id);
    expect(assignments.filter((a) => a.isPrimary).map((a) => a.technicianId)).toEqual([TECH_1]);

    const updated = await getJob(TENANT, job.id, jobRepo);
    expect(updated!.status).toBe('scheduled');
    expect(updated!.assignedTechnicianId).toBe(TECH_1);

    const events = auditRepo.getAll().map((e) => e.eventType);
    expect(events).toContain('job.scheduled');
    expect(events).toContain('job.status_changed');
  });

  it('schedules without a technician: appointment exists but no primary assignment (unassigned)', async () => {
    const job = await newJob();
    const res = await syncJobSchedule(deps([]), { ...scheduleInput(job.id), technicianId: undefined });

    const assignments = await assignmentRepo.findByAppointment(TENANT, res.appointment!.id);
    expect(assignments.filter((a) => a.isPrimary)).toHaveLength(0);
    const updated = await getJob(TENANT, job.id, jobRepo);
    expect(updated!.status).toBe('scheduled');
    expect(updated!.assignedTechnicianId).toBeUndefined();
  });

  it('is idempotent: scheduling twice keeps one appointment; reschedule moves the SAME row', async () => {
    const job = await newJob();
    const first = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    const second = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));

    expect(second.appointment!.id).toBe(first.appointment!.id);
    expect(await activeAppointments(job.id)).toHaveLength(1);

    const resched = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id, { scheduledStart: NEW_START }));
    expect(resched.appointment!.id).toBe(first.appointment!.id);
    expect(resched.appointment!.scheduledStart.toISOString()).toBe(NEW_START.toISOString());
    expect(resched.previousScheduledStart!.toISOString()).toBe(START.toISOString());
    expect(await activeAppointments(job.id)).toHaveLength(1);
  });

  it('reschedule preserves the existing slot length when no duration is given', async () => {
    const job = await newJob();
    await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'schedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
      scheduledStart: START, technicianId: TECH_1, durationMin: 90,
    });
    // Reschedule the start WITHOUT specifying a duration.
    const res = await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'schedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
      scheduledStart: NEW_START,
    });
    const minutes = (res.appointment!.scheduledEnd.getTime() - res.appointment!.scheduledStart.getTime()) / 60000;
    expect(minutes).toBe(90);
    expect(res.appointment!.scheduledStart.toISOString()).toBe(NEW_START.toISOString());
  });

  it('never hijacks an estimate-created appointment (different idempotency key)', async () => {
    const job = await newJob();
    const estAppt = await createAppointment(
      {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: new Date('2030-08-01T10:00:00.000Z'),
        scheduledEnd: new Date('2030-08-01T11:00:00.000Z'),
        timezone: 'UTC',
        idempotencyKey: `from-estimate:${uuidv4()}:auto:auto`,
        createdBy: 'owner-1',
      },
      appointmentRepo,
    );

    const res = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    expect(res.appointment!.id).not.toBe(estAppt.id);

    const reloaded = await appointmentRepo.findById(TENANT, estAppt.id);
    expect(reloaded!.status).toBe('scheduled');
    expect(reloaded!.scheduledStart.toISOString()).toBe('2030-08-01T10:00:00.000Z');
    expect((await appointmentRepo.findByJob(TENANT, job.id))).toHaveLength(2);
  });

  it('reassign to a different technician moves the lane; to null clears it (unassigned)', async () => {
    const job = await newJob();
    const scheduled = await syncJobSchedule(deps([tech(TECH_1), tech(TECH_2)]), scheduleInput(job.id));
    const apptId = scheduled.appointment!.id;

    await syncJobSchedule(deps([tech(TECH_1), tech(TECH_2)]), {
      operation: 'reassign', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner', technicianId: TECH_2,
    });
    let primaries = (await assignmentRepo.findByAppointment(TENANT, apptId)).filter((a) => a.isPrimary);
    expect(primaries.map((a) => a.technicianId)).toEqual([TECH_2]);
    expect((await getJob(TENANT, job.id, jobRepo))!.assignedTechnicianId).toBe(TECH_2);

    await syncJobSchedule(deps([tech(TECH_1), tech(TECH_2)]), {
      operation: 'reassign', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner', technicianId: null,
    });
    primaries = (await assignmentRepo.findByAppointment(TENANT, apptId)).filter((a) => a.isPrimary);
    expect(primaries).toHaveLength(0);
    expect((await getJob(TENANT, job.id, jobRepo))!.assignedTechnicianId).toBeUndefined();

    // Slot unchanged across reassigns.
    const appt = await appointmentRepo.findById(TENANT, apptId);
    expect(appt!.scheduledStart.toISOString()).toBe(START.toISOString());
    expect(auditRepo.getAll().some((e) => e.eventType === 'job.reassigned')).toBe(true);
  });

  it('unschedule cancels the appointment, releases the key, reverts scheduled → new; re-schedule makes a fresh row', async () => {
    const job = await newJob();
    const first = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));

    await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'unschedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner', reason: 'customer canceled',
    });

    const canceled = await appointmentRepo.findById(TENANT, first.appointment!.id);
    expect(canceled!.status).toBe('canceled');
    expect(canceled!.idempotencyKey ?? null).toBeNull();

    const jobAfter = await getJob(TENANT, job.id, jobRepo);
    expect(jobAfter!.status).toBe('new');
    expect(jobAfter!.assignedTechnicianId).toBeUndefined();
    expect(auditRepo.getAll().some((e) => e.eventType === 'job.unscheduled')).toBe(true);

    const second = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    expect(second.appointment!.id).not.toBe(first.appointment!.id);
    expect(second.appointment!.status).toBe('scheduled');
    expect(await activeAppointments(job.id)).toHaveLength(1);
  });

  it('cancelForJob cancels the appointment + releases the key but does NOT revert job status', async () => {
    const job = await newJob();
    const first = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));

    await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'cancelForJob', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
    });

    const appt = await appointmentRepo.findById(TENANT, first.appointment!.id);
    expect(appt!.status).toBe('canceled');
    expect(appt!.idempotencyKey ?? null).toBeNull();
    // The job → canceled transition is owned by the caller; cancelForJob leaves status alone.
    expect((await getJob(TENANT, job.id, jobRepo))!.status).toBe('scheduled');
    expect(auditRepo.getAll().some((e) => e.eventType === 'job.unscheduled')).toBe(false);
  });

  it('does not re-transition an already-scheduled job on a repeated save', async () => {
    const job = await newJob();
    await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    const afterFirst = auditRepo.getAll().filter((e) => e.eventType === 'job.status_changed').length;
    await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    const afterSecond = auditRepo.getAll().filter((e) => e.eventType === 'job.status_changed').length;
    expect(afterSecond).toBe(afterFirst);
  });

  it('rejects a double-booked technician on a fresh schedule (ConflictError)', async () => {
    const jobA = await newJob();
    await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(jobA.id));

    const jobB = await newJob();
    await expect(
      syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(jobB.id)),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects a technicianId that is not a technician (ValidationError)', async () => {
    const job = await newJob();
    const notATech = uuidv4();
    await expect(
      syncJobSchedule(deps([tech(TECH_1), dispatcher(notATech)]), scheduleInput(job.id, { technicianId: notATech })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects reassign when the job has no scheduled appointment (ConflictError)', async () => {
    const job = await newJob();
    await expect(
      syncJobSchedule(deps([tech(TECH_1)]), {
        operation: 'reassign', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner', technicianId: TECH_1,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('unschedule is a no-op when nothing is scheduled', async () => {
    const job = await newJob();
    const res = await syncJobSchedule(deps([]), {
      operation: 'unschedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
    });
    expect(res.appointment).toBeNull();
    expect((await getJob(TENANT, job.id, jobRepo))!.status).toBe('new');
  });

  it('unschedule reverts a job that progressed past scheduled (dispatched → new)', async () => {
    const job = await newJob();
    await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    // Dispatch the job (forward) while its appointment is still 'scheduled'.
    await transitionJobStatus(TENANT, job.id, 'dispatched', 'owner-1', 'owner', jobRepo, timelineRepo);
    expect((await getJob(TENANT, job.id, jobRepo))!.status).toBe('dispatched');

    await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'unschedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
    });

    // Reverted to new (not stranded in 'dispatched' with no appointment).
    expect((await getJob(TENANT, job.id, jobRepo))!.status).toBe('new');
    expect(await activeAppointments(job.id)).toHaveLength(0);
  });

  it('never force-cancels a started/finished appointment (completed canonical row is left alone)', async () => {
    const job = await newJob();
    const scheduled = await syncJobSchedule(deps([tech(TECH_1)]), scheduleInput(job.id));
    // The visit completes via the appointment lifecycle (a different path).
    await appointmentRepo.update(TENANT, scheduled.appointment!.id, { status: 'completed' });

    const res = await syncJobSchedule(deps([tech(TECH_1)]), {
      operation: 'unschedule', tenantId: TENANT, jobId: job.id, actorId: 'owner-1', actorRole: 'owner',
    });

    // No schedulable canonical appointment → no-op; the completed visit is NOT
    // flipped to canceled behind the lifecycle's back.
    expect(res.appointment).toBeNull();
    const appt = await appointmentRepo.findById(TENANT, scheduled.appointment!.id);
    expect(appt!.status).toBe('completed');
  });
});
