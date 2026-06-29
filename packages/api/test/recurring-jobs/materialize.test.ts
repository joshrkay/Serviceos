import { describe, it, expect, beforeEach } from 'vitest';
import {
  dueOccurrenceDates,
  materializeRecurringJob,
  visitWindowUtc,
} from '../../src/recurring-jobs/materialize';
import {
  InMemoryRecurringJobRepository,
  createRecurringJob,
} from '../../src/recurring-jobs/recurring-job';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { InMemoryAppointmentRepository } from '../../src/appointments/in-memory-appointment';
import { InMemoryLocationRepository } from '../../src/locations/location';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import type { ServiceLocation } from '../../src/locations/location';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const ACTOR = 'user-1';

function location(over: Partial<ServiceLocation> = {}): ServiceLocation {
  const now = new Date();
  return {
    id: 'loc-1',
    tenantId: TENANT,
    customerId: CUSTOMER,
    street1: '5 Maple',
    city: 'Akron',
    state: 'OH',
    postalCode: '44301',
    country: 'USA',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('visitWindowUtc (R-JOB)', () => {
  it('places a local time-of-day at the right UTC instant (EDT)', () => {
    const { start, end } = visitWindowUtc('2026-06-01', '09:00', 60, 'America/New_York');
    // 2026-06-01 is EDT (UTC-4): 09:00 local → 13:00 UTC.
    expect(start.toISOString()).toBe('2026-06-01T13:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-01T14:00:00.000Z');
  });

  it('is DST-correct (EST in January is UTC-5)', () => {
    const { start } = visitWindowUtc('2026-01-15', '09:00', 60, 'America/New_York');
    expect(start.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('rejects bad date/time', () => {
    expect(() => visitWindowUtc('2026-13-01', '09:00', 60, 'America/New_York')).toThrow();
    expect(() => visitWindowUtc('2026-06-01', '25:00', 60, 'America/New_York')).toThrow();
  });
});

describe('dueOccurrenceDates (R-JOB)', () => {
  const job = { anchorDate: '2026-06-01', rule: { frequency: 'weekly' as const, interval: 1 } };

  it('returns occurrences in [today, today+horizon] not already materialized', () => {
    expect(
      dueOccurrenceDates(job, { today: '2026-06-01', horizonDays: 21, materialized: [] }),
    ).toEqual(['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22']);
  });

  it('excludes already-materialized dates', () => {
    expect(
      dueOccurrenceDates(job, {
        today: '2026-06-01',
        horizonDays: 21,
        materialized: ['2026-06-08'],
      }),
    ).toEqual(['2026-06-01', '2026-06-15', '2026-06-22']);
  });

  it('does not backfill occurrences before today', () => {
    expect(
      dueOccurrenceDates(job, { today: '2026-06-10', horizonDays: 14, materialized: [] }),
    ).toEqual(['2026-06-15', '2026-06-22']);
  });

  it('honors a count-bounded rule without throwing (no count+until clash)', () => {
    const counted = { anchorDate: '2026-06-01', rule: { frequency: 'weekly' as const, interval: 1, count: 3 } };
    // Horizon spans well past the 3rd occurrence; count must cap the total.
    expect(
      dueOccurrenceDates(counted, { today: '2026-06-01', horizonDays: 90, materialized: [] }),
    ).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });

  it('does not generate past an until-bounded rule even when the horizon is longer', () => {
    const bounded = {
      anchorDate: '2026-06-01',
      rule: { frequency: 'weekly' as const, interval: 1, until: '2026-06-10' },
    };
    expect(
      dueOccurrenceDates(bounded, { today: '2026-06-01', horizonDays: 90, materialized: [] }),
    ).toEqual(['2026-06-01', '2026-06-08']);
  });
});

describe('materializeRecurringJob (R-JOB)', () => {
  let recurringJobRepo: InMemoryRecurringJobRepository;
  let jobRepo: InMemoryJobRepository;
  let appointmentRepo: InMemoryAppointmentRepository;
  let locationRepo: InMemoryLocationRepository;
  let auditRepo: InMemoryAuditRepository;

  beforeEach(async () => {
    recurringJobRepo = new InMemoryRecurringJobRepository();
    jobRepo = new InMemoryJobRepository();
    appointmentRepo = new InMemoryAppointmentRepository();
    locationRepo = new InMemoryLocationRepository();
    auditRepo = new InMemoryAuditRepository();
    await locationRepo.create(location());
  });

  function deps() {
    return { recurringJobRepo, jobRepo, appointmentRepo, locationRepo, auditRepo };
  }

  async function series() {
    return createRecurringJob(
      {
        tenantId: TENANT,
        customerId: CUSTOMER,
        title: 'Weekly lawn',
        anchorDate: '2026-06-01',
        anchorTime: '08:00',
        durationMinutes: 90,
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: ACTOR,
      },
      recurringJobRepo,
    );
  }

  it('creates a job + appointment + ledger row per due occurrence', async () => {
    const job = await series();
    const result = await materializeRecurringJob(
      job,
      { today: '2026-06-01', horizonDays: 14, timezone: 'America/New_York', actorId: ACTOR },
      deps(),
    );
    expect(result.generated).toHaveLength(3); // Jun 1, 8, 15

    // Jobs exist and carry the series title + resolved location.
    for (const v of result.generated) {
      const created = await jobRepo.findById(TENANT, v.jobId);
      expect(created?.summary).toBe('Weekly lawn');
      expect(created?.locationId).toBe('loc-1');
      const appt = await appointmentRepo.findById(TENANT, v.appointmentId);
      // 08:00 EDT → 12:00 UTC; +90 min → 13:30 UTC.
      expect(appt?.scheduledStart.toISOString()).toBe(`${v.occurrenceDate}T12:00:00.000Z`);
    }
    expect(await recurringJobRepo.listMaterializedDates(TENANT, job.id)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
    ]);
  });

  it('is idempotent — a second run generates nothing new', async () => {
    const job = await series();
    const opts = { today: '2026-06-01', horizonDays: 14, timezone: 'America/New_York', actorId: ACTOR };
    const first = await materializeRecurringJob(job, opts, deps());
    expect(first.generated).toHaveLength(3);
    const second = await materializeRecurringJob(job, opts, deps());
    expect(second.generated).toHaveLength(0);
    expect(await recurringJobRepo.listMaterializedDates(TENANT, job.id)).toHaveLength(3);
  });

  it('extends the horizon on a later run without re-creating earlier visits', async () => {
    const job = await series();
    await materializeRecurringJob(
      job,
      { today: '2026-06-01', horizonDays: 7, timezone: 'America/New_York', actorId: ACTOR },
      deps(),
    );
    const more = await materializeRecurringJob(
      job,
      { today: '2026-06-01', horizonDays: 21, timezone: 'America/New_York', actorId: ACTOR },
      deps(),
    );
    // Only the newly-in-window occurrences (Jun 15, 22) are added.
    expect(more.generated.map((g) => g.occurrenceDate)).toEqual(['2026-06-15', '2026-06-22']);
  });

  it('skips with a reason when the customer has no service location', async () => {
    const empty = new InMemoryLocationRepository();
    const job = await series();
    const result = await materializeRecurringJob(
      job,
      { today: '2026-06-01', horizonDays: 14, timezone: 'America/New_York', actorId: ACTOR },
      { recurringJobRepo, jobRepo, appointmentRepo, locationRepo: empty, auditRepo },
    );
    expect(result.generated).toHaveLength(0);
    expect(result.skippedReason).toBe('no_location');
  });

  it('releases the claim when visit creation fails, so a retry regenerates it', async () => {
    const job = await series();
    const opts = { today: '2026-06-01', horizonDays: 1, timezone: 'America/New_York', actorId: ACTOR };
    // Force the appointment write to fail after the occurrence has been claimed.
    const realCreate = appointmentRepo.create.bind(appointmentRepo);
    let shouldFail = true;
    appointmentRepo.create = async (appt) => {
      if (shouldFail) throw new Error('db down');
      return realCreate(appt);
    };

    await expect(materializeRecurringJob(job, opts, deps())).rejects.toThrow(/db down/);
    // The failed occurrence must NOT be marked materialized — otherwise it would
    // be skipped forever and that visit would silently never exist.
    expect(await recurringJobRepo.listMaterializedDates(TENANT, job.id)).toHaveLength(0);

    // A later run (write now succeeds) regenerates the released occurrence.
    shouldFail = false;
    const retry = await materializeRecurringJob(job, opts, deps());
    expect(retry.generated.map((g) => g.occurrenceDate)).toEqual(['2026-06-01']);
    expect(await recurringJobRepo.listMaterializedDates(TENANT, job.id)).toEqual(['2026-06-01']);
  });

  it('emits a visit_generated audit event per occurrence', async () => {
    const job = await series();
    await materializeRecurringJob(
      job,
      { today: '2026-06-01', horizonDays: 7, timezone: 'America/New_York', actorId: ACTOR },
      deps(),
    );
    const events = await auditRepo.findByEntity(TENANT, 'recurring_job', job.id);
    const generated = events.filter((e) => e.eventType === 'recurring_job.visit_generated');
    expect(generated.length).toBe(2); // Jun 1, Jun 8
  });
});
