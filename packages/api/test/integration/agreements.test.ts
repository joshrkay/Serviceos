/**
 * Postgres integration — service agreements (PgAgreementRepository).
 *
 * Covers the real SQL for recurring service agreements: tenant-scoped lookups,
 * customer/status filters, the findDue window used by the recurring-agreements
 * worker, and partial updates. Previously only the in-memory repo was tested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgAgreementRepository } from '../../src/agreements/pg-agreement';
import type { Agreement } from '../../src/agreements/agreement';

async function createCustomer(pool: Pool, tenantId: string, createdBy: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
    [id, tenantId, 'Acme Co', createdBy],
  );
  return id;
}

function makeAgreement(
  tenantId: string,
  customerId: string,
  createdBy: string,
  overrides: Partial<Agreement> = {},
): Agreement {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    customerId,
    name: 'Monthly HVAC service',
    recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1',
    priceCents: 99_00,
    autoGenerateInvoice: true,
    autoGenerateJob: true,
    nextRunAt: now,
    status: 'active',
    startsOn: '2026-01-01',
    createdBy,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Postgres integration — service agreements', () => {
  let pool: Pool;
  let repo: PgAgreementRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };
  let customerId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgAgreementRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
    customerId = await createCustomer(pool, tenant.tenantId, tenant.userId);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('create / findById', () => {
    it('round-trips an agreement, coercing BIGINT price to a number', async () => {
      const created = await repo.create(makeAgreement(tenant.tenantId, customerId, tenant.userId));
      const found = await repo.findById(tenant.tenantId, created.id);
      expect(found).not.toBeNull();
      expect(found!.priceCents).toBe(99_00);
      expect(typeof found!.priceCents).toBe('number');
      expect(found!.startsOn).toBe('2026-01-01');
      expect(found!.recurrenceRule).toBe('FREQ=MONTHLY;INTERVAL=1');
    });

    it('does not leak across tenants', async () => {
      const created = await repo.create(makeAgreement(tenant.tenantId, customerId, tenant.userId));
      expect(await repo.findById(other.tenantId, created.id)).toBeNull();
    });
  });

  describe('findByTenant', () => {
    let t: { tenantId: string; userId: string };
    let cust: string;

    beforeAll(async () => {
      t = await createTestTenant(pool);
      cust = await createCustomer(pool, t.tenantId, t.userId);
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { status: 'active' }));
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { status: 'paused' }));
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { status: 'cancelled' }));
    });

    it('filters by status', async () => {
      const active = await repo.findByTenant(t.tenantId, { status: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('active');
    });

    it('filters by customer and paginates', async () => {
      const byCustomer = await repo.findByTenant(t.tenantId, { customerId: cust });
      expect(byCustomer).toHaveLength(3);
      const page = await repo.findByTenant(t.tenantId, { customerId: cust, limit: 2, offset: 0 });
      expect(page).toHaveLength(2);
    });
  });

  describe('findDue', () => {
    let t: { tenantId: string; userId: string };
    let cust: string;
    const asOf = new Date('2026-06-01T00:00:00Z');

    beforeAll(async () => {
      t = await createTestTenant(pool);
      cust = await createCustomer(pool, t.tenantId, t.userId);
      // Due: active and next_run_at in the past.
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { nextRunAt: new Date('2026-05-01T00:00:00Z') }));
      // Not due: scheduled in the future.
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { nextRunAt: new Date('2026-07-01T00:00:00Z') }));
      // Not due: paused even though next_run_at is in the past.
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { nextRunAt: new Date('2026-05-01T00:00:00Z'), status: 'paused' }));
      // Not due: ended before asOf.
      await repo.create(makeAgreement(t.tenantId, cust, t.userId, { nextRunAt: new Date('2026-05-01T00:00:00Z'), endsOn: '2026-04-01' }));
    });

    it('returns only active, past-due, not-yet-ended agreements', async () => {
      const due = await repo.findDue(t.tenantId, asOf);
      expect(due).toHaveLength(1);
      expect(due[0].status).toBe('active');
      expect(due[0].nextRunAt.getTime()).toBeLessThanOrEqual(asOf.getTime());
    });
  });

  describe('update', () => {
    it('applies a partial update, leaving other fields intact', async () => {
      const created = await repo.create(makeAgreement(tenant.tenantId, customerId, tenant.userId));
      const updated = await repo.update(tenant.tenantId, created.id, { status: 'paused', priceCents: 150_00 });
      expect(updated!.status).toBe('paused');
      expect(updated!.priceCents).toBe(150_00);
      expect(updated!.name).toBe('Monthly HVAC service');
    });

    it('returns the existing row when given no mapped fields', async () => {
      const created = await repo.create(makeAgreement(tenant.tenantId, customerId, tenant.userId));
      const result = await repo.update(tenant.tenantId, created.id, {} as Partial<Agreement>);
      expect(result!.id).toBe(created.id);
    });

    it('returns null for a missing agreement', async () => {
      expect(await repo.update(tenant.tenantId, crypto.randomUUID(), { status: 'cancelled' })).toBeNull();
    });
  });
});
