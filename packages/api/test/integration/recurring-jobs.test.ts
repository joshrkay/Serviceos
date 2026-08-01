import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAppointmentRepository } from '../../src/appointments/pg-appointment';
import { PgRecurringJobRepository } from '../../src/recurring-jobs/pg-recurring-job';
import { materializeRecurringJob } from '../../src/recurring-jobs/materialize';
import {
  createRecurringJob,
  updateRecurringJob,
  upcomingOccurrences,
} from '../../src/recurring-jobs/recurring-job';

async function seedCustomer(pool: Pool, tenantId: string, userId: string): Promise<string> {
  const customers = new PgCustomerRepository(pool);
  const id = crypto.randomUUID();
  await customers.create({
    id,
    tenantId,
    firstName: 'Rec',
    lastName: 'Customer',
    displayName: 'Rec Customer',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

describe('Postgres integration — recurring jobs (migration 222)', () => {
  let pool: Pool;
  let repo: PgRecurringJobRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgRecurringJobRepository(pool);
    tenant = await createTestTenant(pool);
    customerId = await seedCustomer(pool, tenant.tenantId, tenant.userId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('persists a series with a DATE anchor and JSONB rule, round-tripping cleanly', async () => {
    const job = await createRecurringJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        title: 'Monthly HVAC maintenance',
        anchorDate: '2026-01-31',
        rule: { frequency: 'monthly', interval: 1, count: 12 },
        notes: 'Replace filter, check refrigerant',
        createdBy: tenant.userId,
      },
      repo,
    );

    const { rows } = await pool.query(
      `SELECT tenant_id, customer_id, title, anchor_date, rule, notes, is_archived
         FROM recurring_jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].customer_id).toBe(customerId);
    expect(rows[0].title).toBe('Monthly HVAC maintenance');
    expect(rows[0].rule).toMatchObject({ frequency: 'monthly', interval: 1, count: 12 });
    expect(rows[0].is_archived).toBe(false);

    // Anchor date round-trips to the same calendar day (no TZ drift).
    const reloaded = await repo.findById(tenant.tenantId, job.id);
    expect(reloaded!.anchorDate).toBe('2026-01-31');
    // And the engine clamps month-ends off that anchor.
    expect(upcomingOccurrences(reloaded!, undefined, 3)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('lists by customer, updates, and archives', async () => {
    const job = await createRecurringJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        title: 'Weekly lawn',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: tenant.userId,
      },
      repo,
    );

    const byCustomer = await repo.list(tenant.tenantId, { customerId });
    expect(byCustomer.map((j) => j.id)).toContain(job.id);

    const updated = await updateRecurringJob(
      tenant.tenantId,
      job.id,
      { rule: { frequency: 'biweekly', interval: 1 } },
      repo,
      tenant.userId,
    );
    expect(updated.rule.frequency).toBe('biweekly');

    await repo.archive(tenant.tenantId, job.id);
    const active = await repo.list(tenant.tenantId);
    expect(active.map((j) => j.id)).not.toContain(job.id);
  });

  it('does not leak series across tenants (RLS)', async () => {
    const job = await createRecurringJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        title: 'Secret',
        anchorDate: '2026-06-01',
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: tenant.userId,
      },
      repo,
    );
    const other = await createTestTenant(pool);
    expect(await repo.findById(other.tenantId, job.id)).toBeNull();
    expect(await repo.list(other.tenantId)).toEqual([]);
  });

  it('materializes due occurrences into real jobs + appointments, idempotently', async () => {
    const locations = new PgLocationRepository(pool);
    await locations.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      customerId,
      street1: '5 Maple',
      city: 'Akron',
      state: 'OH',
      postalCode: '44301',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await createRecurringJob(
      {
        tenantId: tenant.tenantId,
        customerId,
        title: 'Weekly lawn',
        anchorDate: '2026-06-01',
        anchorTime: '08:00',
        durationMinutes: 90,
        rule: { frequency: 'weekly', interval: 1 },
        createdBy: tenant.userId,
      },
      repo,
    );

    const deps = {
      recurringJobRepo: repo,
      jobRepo: new PgJobRepository(pool),
      appointmentRepo: new PgAppointmentRepository(pool),
      locationRepo: locations,
    };
    const opts = {
      today: '2026-06-01',
      horizonDays: 14,
      timezone: 'America/New_York',
      actorId: tenant.userId,
    };

    const first = await materializeRecurringJob(job, opts, deps);
    expect(first.generated).toHaveLength(3); // Jun 1, 8, 15

    // Each generated visit links a real job + appointment in the ledger.
    const { rows } = await pool.query(
      `SELECT occurrence_date, job_id, appointment_id
         FROM recurring_job_occurrences
        WHERE tenant_id = $1 AND recurring_job_id = $2
        ORDER BY occurrence_date ASC`,
      [tenant.tenantId, job.id],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.job_id && r.appointment_id)).toBe(true);

    const appt = await deps.appointmentRepo.findById(tenant.tenantId, first.generated[0].appointmentId);
    // 08:00 EDT (UTC-4) → 12:00 UTC.
    expect(appt!.scheduledStart.toISOString()).toBe('2026-06-01T12:00:00.000Z');

    // Idempotent: a second run with the same window creates nothing new.
    const second = await materializeRecurringJob(job, opts, deps);
    expect(second.generated).toHaveLength(0);
    expect(await repo.listMaterializedDates(tenant.tenantId, job.id)).toHaveLength(3);
  });
});
