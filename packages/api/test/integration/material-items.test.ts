/**
 * Postgres integration — material items (PgMaterialItemRepository).
 *
 * Tradesperson wave 1, Task 8: material_items (migration 272) is a brand new
 * TABLE. This pins the real SQL — create -> listPending -> markPurchased —
 * AND proves RLS actually isolates tenants at the DB level (not just via the
 * repo's own `WHERE tenant_id = $1`, which would pass even with a broken or
 * absent policy). The DB-level check runs through the unprivileged
 * `rls_app_runtime` role, mirroring rls-tenant-isolation.test.ts, since the
 * testcontainer's default connection is a superuser and superusers bypass
 * RLS unconditionally.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  getSharedTestDb,
  createTestTenant,
  closeSharedTestDb,
  RLS_APP_ROLE,
  TestTenant,
} from './shared';
import { PgMaterialItemRepository } from '../../src/materials/pg-material-item';

/**
 * Insert the customer -> location -> job FK chain under tenant RLS context.
 * Mirrors the identically-named helper in feedback.test.ts.
 */
async function createJob(pool: Pool, tenant: TestTenant): Promise<string> {
  const customerId = randomUUID();
  const locationId = randomUUID();
  const jobId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
    await client.query(
      `INSERT INTO customers (id, tenant_id, display_name, created_by) VALUES ($1, $2, $3, $4)`,
      [customerId, tenant.tenantId, 'Test Customer', tenant.userId],
    );
    await client.query(
      `INSERT INTO service_locations (id, tenant_id, customer_id, street1, city, state, postal_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [locationId, tenant.tenantId, customerId, '1 Main St', 'Austin', 'TX', '78701'],
    );
    await client.query(
      `INSERT INTO jobs (id, tenant_id, customer_id, location_id, job_number, summary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, tenant.tenantId, customerId, locationId, `JOB-${jobId.slice(0, 8)}`, 'Test job', tenant.userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return jobId;
}

/**
 * Run `fn` on a connection that behaves like the production app: an
 * unprivileged role with `app.current_tenant_id` set for the duration of a
 * transaction. Always rolls back so the test is side-effect free. Mirrors
 * `asTenant` in rls-tenant-isolation.test.ts.
 */
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${RLS_APP_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('Postgres integration — material items', () => {
  let pool: Pool;
  let repo: PgMaterialItemRepository;
  let tenant: { tenantId: string; userId: string };
  let other: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgMaterialItemRepository(pool);
    tenant = await createTestTenant(pool);
    other = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('round-trips create -> listPending -> markPurchased', async () => {
    const created = await repo.create({
      tenantId: tenant.tenantId,
      description: '3 boxes 1/2" PEX',
      quantity: 3,
      createdBy: tenant.userId,
    });
    expect(created.status).toBe('pending');
    expect(created.quantity).toBe(3);
    expect(typeof created.quantity).toBe('number');

    const pending = await repo.listPending(tenant.tenantId);
    expect(pending.map((i) => i.id)).toContain(created.id);

    const purchased = await repo.markPurchased(tenant.tenantId, created.id, tenant.userId);
    expect(purchased).not.toBeNull();
    expect(purchased!.status).toBe('purchased');
    expect(purchased!.purchasedBy).toBe(tenant.userId);
    expect(purchased!.purchasedAt).toBeInstanceOf(Date);

    const stillPending = await repo.listPending(tenant.tenantId);
    expect(stillPending.map((i) => i.id)).not.toContain(created.id);
  });

  it('scopes listPending by jobId when given', async () => {
    const jobId = await createJob(pool, tenant);
    await repo.create({
      tenantId: tenant.tenantId,
      description: 'job-scoped item',
      jobId,
      createdBy: tenant.userId,
    });
    await repo.create({
      tenantId: tenant.tenantId,
      description: 'unscoped item',
      createdBy: tenant.userId,
    });

    const scoped = await repo.listPending(tenant.tenantId, { jobId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].description).toBe('job-scoped item');
  });

  it('does not mark another tenant\'s item purchased (repo-level tenant check)', async () => {
    const created = await repo.create({
      tenantId: tenant.tenantId,
      description: 'cross-tenant guard',
      createdBy: tenant.userId,
    });
    const result = await repo.markPurchased(other.tenantId, created.id, other.userId);
    expect(result).toBeNull();
  });

  describe('RLS enforcement (DB-level, unprivileged role)', () => {
    it('a tenant reading material_items directly sees only its own rows', async () => {
      const mine = await repo.create({
        tenantId: tenant.tenantId,
        description: 'mine',
        createdBy: tenant.userId,
      });
      const theirs = await repo.create({
        tenantId: other.tenantId,
        description: 'theirs',
        createdBy: other.userId,
      });

      const idsVisibleToTenant = await asTenant(pool, tenant.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM material_items');
        return rows.map((r) => r.id);
      });
      expect(idsVisibleToTenant).toContain(mine.id);
      expect(idsVisibleToTenant).not.toContain(theirs.id);

      const idsVisibleToOther = await asTenant(pool, other.tenantId, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM material_items');
        return rows.map((r) => r.id);
      });
      expect(idsVisibleToOther).toContain(theirs.id);
      expect(idsVisibleToOther).not.toContain(mine.id);
    });

    it('an unknown tenant context cannot enumerate any material_items rows', async () => {
      await repo.create({
        tenantId: tenant.tenantId,
        description: 'should stay hidden',
        createdBy: tenant.userId,
      });
      const strangerTenant = randomUUID();
      const count = await asTenant(pool, strangerTenant, async (client) => {
        const { rows } = await client.query('SELECT id FROM material_items');
        return rows.length;
      });
      expect(count).toBe(0);
    });

    it('an unprivileged role scoped to tenant A cannot UPDATE tenant B\'s row', async () => {
      const theirs = await repo.create({
        tenantId: other.tenantId,
        description: 'not yours to purchase',
        createdBy: other.userId,
      });

      const updatedCount = await asTenant(pool, tenant.tenantId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE material_items SET status = 'purchased' WHERE id = $1`,
          [theirs.id],
        );
        return rowCount;
      });
      expect(updatedCount).toBe(0);

      // Untouched — still pending under its real tenant.
      const stillPending = await repo.listPending(other.tenantId);
      expect(stillPending.map((i) => i.id)).toContain(theirs.id);
    });
  });
});
