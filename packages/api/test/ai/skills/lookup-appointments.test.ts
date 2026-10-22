import { describe, it, expect, beforeEach } from 'vitest';
import { lookupAppointments } from '../../../src/ai/skills/lookup-appointments';
import { createJob, InMemoryJobRepository } from '../../../src/jobs/job';
import {
  createAppointment,
  InMemoryAppointmentRepository,
} from '../../../src/appointments/appointment';
import { InMemoryLookupEventRepository } from '../../../src/lookup-events/lookup-event';
import { LookupEventService } from '../../../src/lookup-events/lookup-event-service';

describe('P11-001 — lookupAppointments skill', () => {
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let lookupRepo: InMemoryLookupEventRepository;
  let lookupEvents: LookupEventService;

  beforeEach(() => {
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    lookupRepo = new InMemoryLookupEventRepository();
    lookupEvents = new LookupEventService(lookupRepo);
  });

  async function seedJobAndAppointment(opts: {
    tenantId?: string;
    customerId?: string;
    summary?: string;
    scheduledStart: Date;
  }) {
    const job = await createJob(
      {
        tenantId: opts.tenantId ?? 'tenant-1',
        customerId: opts.customerId ?? 'cust-1',
        locationId: 'loc-1',
        summary: opts.summary ?? 'AC repair',
        createdBy: 'u-1',
      },
      jobRepo,
    );
    await createAppointment(
      {
        tenantId: job.tenantId,
        jobId: job.id,
        scheduledStart: opts.scheduledStart,
        scheduledEnd: new Date(opts.scheduledStart.getTime() + 60 * 60 * 1000),
        timezone: 'America/Los_Angeles',
        createdBy: 'u-1',
      },
      appointmentRepo,
    );
    return job;
  }

  it('happy path — found returns summary mentioning the next appointment', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedJobAndAppointment({ summary: 'AC repair', scheduledStart: future });

    const result = await lookupAppointments(
      {
        tenantId: 'tenant-1',
        customerId: 'cust-1',
        timezone: 'America/Los_Angeles',
      },
      { jobRepo, appointmentRepo, lookupEvents },
    );

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.appointments).toHaveLength(1);
    expect(result.summary).toContain('AC repair');
  });

  it('none — returns a friendly summary when nothing upcoming', async () => {
    const result = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-empty' },
      { jobRepo, appointmentRepo, lookupEvents },
    );
    expect(result.status).toBe('none');
    expect(result.summary.toLowerCase()).toContain("not seeing");
  });

  it('tenant isolation — never returns appointments from another tenant', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedJobAndAppointment({
      tenantId: 'tenant-2',
      customerId: 'cust-shared',
      scheduledStart: future,
    });

    const result = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-shared' },
      { jobRepo, appointmentRepo, lookupEvents },
    );

    expect(result.status).toBe('none');
  });

  it('audit — writes a lookup_events row on each invocation', async () => {
    await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', sessionId: 'sess-1' },
      { jobRepo, appointmentRepo, lookupEvents },
    );

    const rows = await lookupRepo.listByTenant('tenant-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].intent).toBe('lookup_appointments');
    expect(rows[0].sessionId).toBe('sess-1');
  });

  it('narrows to one job when the question was about that job', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const a = await seedJobAndAppointment({ summary: 'AC repair', scheduledStart: future });
    await seedJobAndAppointment({ summary: 'Water heater', scheduledStart: new Date(future.getTime() + 3600_000) });
    const result = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', jobId: a.id, timezone: 'America/Los_Angeles' },
      { jobRepo, appointmentRepo, lookupEvents },
    );
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.data.appointments.map((x) => x.jobId)).toEqual([a.id]);
  });
  it('appointmentId answers for that one visit, including a canceled one', async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const job = await seedJobAndAppointment({ summary: 'AC repair', scheduledStart: soon });
    const [first] = await appointmentRepo.findByJob('tenant-1', job.id);
    const second = await createAppointment(
      {
        tenantId: 'tenant-1', jobId: job.id, scheduledStart: later,
        scheduledEnd: new Date(later.getTime() + 60 * 60 * 1000), timezone: 'America/Los_Angeles', createdBy: 'u-1',
      },
      appointmentRepo,
    );
    await appointmentRepo.update('tenant-1', second.id, { status: 'canceled' });

    const canceled = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', appointmentId: second.id },
      { jobRepo, appointmentRepo },
    );
    expect(canceled.status).toBe('found');
    expect(canceled.summary).toMatch(/^This visit, .* for AC repair, was canceled\.$/);

    const upcoming = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', appointmentId: first.id },
      { jobRepo, appointmentRepo },
    );
    expect(upcoming.summary).toMatch(/^This visit is .* for AC repair\.$/);

    // A visit on a canceled job is still the visit on screen.
    await jobRepo.update('tenant-1', job.id, { status: 'canceled' });
    const onCanceledJob = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', appointmentId: second.id },
      { jobRepo, appointmentRepo },
    );
    expect(onCanceledJob.summary).toMatch(/was canceled\.$/);

    const missing = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', appointmentId: 'nope' },
      { jobRepo, appointmentRepo },
    );
    expect(missing).toMatchObject({ status: 'none', summary: "I couldn't find the visit you were viewing." });
  });
  it('appointmentId finds an old visit even when the customer has more jobs than the list returns', async () => {
    const past = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const oldJob = await seedJobAndAppointment({ summary: 'Original install', scheduledStart: past });
    const [visit] = await appointmentRepo.findByJob('tenant-1', oldJob.id);
    for (let i = 0; i < 205; i++) {
      await createJob(
        { tenantId: 'tenant-1', customerId: 'cust-1', locationId: 'loc-1', summary: `Visit ${i}`, createdBy: 'u-1' },
        jobRepo,
      );
    }
    const r = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-1', appointmentId: visit.id },
      { jobRepo, appointmentRepo },
    );
    expect(r.summary).toMatch(/^This visit was .* for Original install\.$/);

    // Another customer's visit is not answered.
    const other = await lookupAppointments(
      { tenantId: 'tenant-1', customerId: 'cust-2', appointmentId: visit.id },
      { jobRepo, appointmentRepo },
    );
    expect(other.summary).toBe("I couldn't find the visit you were viewing.");
  });
});
