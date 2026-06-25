/**
 * Postgres integration — RLS runtime-role ENFORCEMENT (U4).
 *
 * Proves the whole point of the feature against real Postgres: with
 * RLS_RUNTIME_ROLE=true, a tenant-scoped query under the rls_app_runtime role
 * cannot see another tenant's rows even when the SQL omits a tenant_id filter,
 * an unset GUC fails closed, normal same-tenant queries still work, and the
 * privileged (withClient) path still sees all tenants. A mocked Pool can prove
 * none of this — RLS only enforces against a real, RLS-subject role.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';

let pool: Pool;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

beforeAll(async () => {
  pool = await getSharedTestDb();
  process.env.RLS_RUNTIME_ROLE = 'true'; // activate the role drop for these tests
});
afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  await closeSharedTestDb();
});

async function seedCustomer(tenantId: string, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'T', 'Cust', 'T Cust', $3)`,
    [id, tenantId, userId]
  );
  return id;
}

async function seedOauthState(tenantId: string, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO oauth_states (id, tenant_id, user_id, provider, redirect_after)
     VALUES ($1, $2, $3, 'google', '/settings')`,
    [id, tenantId, userId]
  );
  return id;
}

describe('RLS runtime-role enforcement (real Postgres, RLS_RUNTIME_ROLE=true)', () => {
  let tracked: PoolClient[] = [];
  afterEach(async () => {
    for (const c of tracked) {
      await clearTenantContext(c);
      c.release();
    }
    tracked = [];
  });

  it('R1: a tenant-filter-less query under the role sees only the active tenant', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const aCustomer = await seedCustomer(a.tenantId, a.userId);
    await seedCustomer(b.tenantId, b.userId);

    const client = await pool.connect();
    tracked.push(client);
    await applyTenantContext(client, b.tenantId); // session SET + SET ROLE rls_app_runtime

    // No tenant_id predicate in the SQL — RLS must scope it to tenant B.
    const all = await client.query('SELECT tenant_id FROM customers');
    expect(all.rows.every((r) => r.tenant_id === b.tenantId)).toBe(true);

    // A's customer is invisible even by direct id.
    const direct = await client.query('SELECT id FROM customers WHERE id = $1', [aCustomer]);
    expect(direct.rowCount).toBe(0);
  });

  it('R1: the oauth_states gap (U2) is now enforced too', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const aState = await seedOauthState(a.tenantId, a.userId);

    const client = await pool.connect();
    tracked.push(client);
    await applyTenantContext(client, b.tenantId);
    const res = await client.query('SELECT id FROM oauth_states WHERE id = $1', [aState]);
    expect(res.rowCount).toBe(0);
  });

  it('R2: an unset tenant GUC under the role fails closed (not all rows)', async () => {
    const a = await createTestTenant(pool);
    await seedCustomer(a.tenantId, a.userId);

    const client = await pool.connect();
    tracked.push(client);
    // Drop to the role but clear the GUC — the policy's ::uuid cast on '' rejects.
    await applyTenantContext(client, a.tenantId);
    await client.query('RESET app.current_tenant_id');
    await expect(client.query('SELECT * FROM customers')).rejects.toThrow();
  });

  it('R3: normal same-tenant read + write succeed under the role (no missing grant)', async () => {
    const a = await createTestTenant(pool);
    const client = await pool.connect();
    tracked.push(client);
    await applyTenantContext(client, a.tenantId);

    const insert = await client.query(
      `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
       VALUES ($1, $2, 'New', 'One', 'New One', $3) RETURNING id`,
      [crypto.randomUUID(), a.tenantId, a.userId]
    );
    expect(insert.rowCount).toBe(1);
    const read = await client.query('SELECT count(*)::int AS n FROM customers');
    expect(read.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('R4: the privileged path (no role drop) still sees all tenants', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    await seedCustomer(a.tenantId, a.userId);
    await seedCustomer(b.tenantId, b.userId);

    // withClient-style: a plain connection with NO applyTenantContext → privileged.
    const client = await pool.connect();
    try {
      const distinct = await client.query(
        'SELECT count(DISTINCT tenant_id)::int AS tenants FROM customers WHERE tenant_id = ANY($1)',
        [[a.tenantId, b.tenantId]]
      );
      expect(distinct.rows[0].tenants).toBe(2);
    } finally {
      client.release();
    }
  });

  it('pool hygiene: clearTenantContext returns the connection to the privileged role', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    await seedCustomer(a.tenantId, a.userId);
    await seedCustomer(b.tenantId, b.userId);

    const client = await pool.connect();
    try {
      await applyTenantContext(client, a.tenantId);
      await clearTenantContext(client); // resets ROLE + GUC
      // Back on the privileged role with no GUC → sees both tenants again.
      const res = await client.query(
        'SELECT count(DISTINCT tenant_id)::int AS tenants FROM customers WHERE tenant_id = ANY($1)',
        [[a.tenantId, b.tenantId]]
      );
      expect(res.rows[0].tenants).toBe(2);
    } finally {
      client.release();
    }
  });
});
