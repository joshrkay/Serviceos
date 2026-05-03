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
});
