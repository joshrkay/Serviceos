import { describe, it, expect, beforeEach } from 'vitest';
import { scheduleJob, ScheduleJobDeps } from '../../src/jobs/schedule-job';
import { createJob, InMemoryJobRepository, Job } from '../../src/jobs/job';
import { InMemoryJobTimelineRepository } from '../../src/jobs/job-lifecycle';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const TENANT = '11111111-1111-1111-1111-111111111111';
const START = new Date('2026-07-01T15:00:00.000Z');

describe('scheduleJob — dispatch board Issue 2 (job → appointment)', () => {
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let timelineRepo: InMemoryJobTimelineRepository;
  let auditRepo: InMemoryAuditRepository;
  let deps: ScheduleJobDeps;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    timelineRepo = new InMemoryJobTimelineRepository();
    auditRepo = new InMemoryAuditRepository();
    deps = { jobRepo, appointmentRepo, timelineRepo, auditRepo };
  });

  async function newJob(): Promise<Job> {
    return createJob(
      { tenantId: TENANT, customerId: 'c-1', locationId: 'l-1', summary: 'AC not cooling', createdBy: 'u-1' },
      jobRepo,
    );
  }

  it('creates an unassigned appointment and moves the job new → scheduled', async () => {
    const job = await newJob();

    const { job: updated, appointment } = await scheduleJob(deps, {
      tenantId: TENANT,
      jobId: job.id,
      scheduledStart: START,
      timezone: 'America/Chicago',
      actorId: 'u-1',
      actorRole: 'dispatcher',
    });

    expect(updated.status).toBe('scheduled');
    expect(appointment.jobId).toBe(job.id);
    expect(appointment.status).toBe('scheduled');
    expect(appointment.scheduledStart.toISOString()).toBe(START.toISOString());

    // Persisted so the dispatch board (which reads appointments) can see it.
    const persisted = await appointmentRepo.findByJob(TENANT, job.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(appointment.id);
  });

  it('defaults the appointment to a 60-minute duration when no end is given', async () => {
    const job = await newJob();
    const { appointment } = await scheduleJob(deps, {
      tenantId: TENANT, jobId: job.id, scheduledStart: START, actorId: 'u-1',
    });
    expect(appointment.scheduledEnd.getTime() - appointment.scheduledStart.getTime()).toBe(60 * 60_000);
  });

  it('honors an explicit duration', async () => {
    const job = await newJob();
    const { appointment } = await scheduleJob(deps, {
      tenantId: TENANT, jobId: job.id, scheduledStart: START, durationMin: 90, actorId: 'u-1',
    });
    expect(appointment.scheduledEnd.getTime() - appointment.scheduledStart.getTime()).toBe(90 * 60_000);
  });

  it('honors an explicit end over duration', async () => {
    const job = await newJob();
    const end = new Date('2026-07-01T17:30:00.000Z');
    const { appointment } = await scheduleJob(deps, {
      tenantId: TENANT, jobId: job.id, scheduledStart: START, scheduledEnd: end, durationMin: 30, actorId: 'u-1',
    });
    expect(appointment.scheduledEnd.toISOString()).toBe(end.toISOString());
  });

  it('emits appointment.created and job.status_changed audit events', async () => {
    const job = await newJob();
    auditRepo.clear();
    await scheduleJob(deps, { tenantId: TENANT, jobId: job.id, scheduledStart: START, actorId: 'u-1' });

    const types = auditRepo.getAll().map((e) => e.eventType);
    expect(types).toContain('appointment.created');
    expect(types).toContain('job.status_changed');
  });

  it('adds another appointment for an already-scheduled job without changing status', async () => {
    const job = await newJob();
    await scheduleJob(deps, { tenantId: TENANT, jobId: job.id, scheduledStart: START, actorId: 'u-1' });

    const second = new Date('2026-07-02T15:00:00.000Z');
    const { job: updated } = await scheduleJob(deps, {
      tenantId: TENANT, jobId: job.id, scheduledStart: second, actorId: 'u-1',
    });

    expect(updated.status).toBe('scheduled');
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(2);
  });

  it('rejects scheduling a job in a terminal status and creates no appointment', async () => {
    const job = await newJob();
    await jobRepo.update(TENANT, job.id, { status: 'completed' });

    await expect(
      scheduleJob(deps, { tenantId: TENANT, jobId: job.id, scheduledStart: START, actorId: 'u-1' }),
    ).rejects.toThrow(/Cannot schedule a job in status 'completed'/);
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(0);
  });

  it('throws NotFoundError for an unknown job', async () => {
    await expect(
      scheduleJob(deps, {
        tenantId: TENANT,
        jobId: '22222222-2222-2222-2222-222222222222',
        scheduledStart: START,
        actorId: 'u-1',
      }),
    ).rejects.toThrow(/Job/);
  });

  it('rejects an unsupported timezone before creating an appointment', async () => {
    const job = await newJob();
    await expect(
      scheduleJob(deps, {
        tenantId: TENANT, jobId: job.id, scheduledStart: START, timezone: 'Mars/Phobos', actorId: 'u-1',
      }),
    ).rejects.toThrow(/Invalid appointment/);
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(0);
  });

  it('rejects an end at or before the start', async () => {
    const job = await newJob();
    await expect(
      scheduleJob(deps, {
        tenantId: TENANT,
        jobId: job.id,
        scheduledStart: START,
        scheduledEnd: new Date(START.getTime() - 60_000),
        actorId: 'u-1',
      }),
    ).rejects.toThrow(/Invalid appointment/);
    expect(await appointmentRepo.findByJob(TENANT, job.id)).toHaveLength(0);
  });

  it('rejects a malformed tenant id', async () => {
    await expect(
      scheduleJob(deps, { tenantId: 'not-a-uuid', jobId: TENANT, scheduledStart: START, actorId: 'u-1' }),
    ).rejects.toThrow(/Invalid tenant ID/);
  });
});
