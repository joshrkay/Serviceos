import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgRecurringJobRepository } from '../../src/recurring-jobs/pg-recurring-job';
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
});
