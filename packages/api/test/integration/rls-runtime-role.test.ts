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
import { Pool as PgPool } from 'pg';
import type { Pool, PoolClient } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { applyTenantContext, clearTenantContext } from '../../src/db/rls-runtime-role';
import { PgPortalSessionRepository } from '../../src/portal/pg-portal-session';
import { PgAccountingIntegrationRepository } from '../../src/integrations/accounting/repository';

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

/**
 * SEC-02 — system-level lookups must set their escape-hatch GUC with SET LOCAL
 * inside the SAME transaction as the dependent SELECT.
 *
 * The repos-under-test run on a pool whose connections assume the restricted,
 * RLS-subject `rls_app_runtime` role at connection start (libpq startup
 * `options: -c role=...`), so RLS actually enforces against them — the same
 * end-state as production with RLS_RUNTIME_ROLE=true. Seeding uses the
 * privileged shared `pool` (BYPASSRLS), which writes across tenants freely.
 *
 * Before the SEC-02 fix, `findByTokenHash` / `findAllActive` issued
 * `set_config(..., is_local=true)` OUTSIDE any transaction; that GUC was
 * discarded before the separate SELECT ran, so under this role the policy
 * evaluated false and the query returned ZERO rows. If either method regresses
 * to the non-transactional pattern, these tests fail (row/rows disappear).
 */
describe('RLS runtime-role: system-level lookups set their GUC transactionally (SEC-02)', () => {
  let rlsPool: PgPool;

  beforeAll(() => {
    rlsPool = new PgPool({
      connectionString: process.env.TEST_DB_URL,
      options: '-c role=rls_app_runtime',
    });
  });
  afterAll(async () => {
    await rlsPool.end();
  });

  it('S1: PgPortalSessionRepository.findByTokenHash returns the row under the enforcing role', async () => {
    const t = await createTestTenant(pool);
    const tokenHash = crypto
      .createHash('sha256')
      .update(crypto.randomUUID())
      .digest('hex');
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO portal_sessions (id, tenant_id, customer_id, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day', $5)`,
      [sessionId, t.tenantId, crypto.randomUUID(), tokenHash, t.userId]
    );

    const repo = new PgPortalSessionRepository(rlsPool);
    // Without the transactional GUC this returns null (0 rows) under the role.
    const found = await repo.findByTokenHash(tokenHash);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(sessionId);
    expect(found!.tenantId).toBe(t.tenantId);

    // A hash with no matching row still resolves to null (not an error).
    const miss = await repo.findByTokenHash('0'.repeat(64));
    expect(miss).toBeNull();
  });

  it('S2: AccountingIntegrationRepository.findAllActive returns active integrations under the enforcing role', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    const c = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO accounting_integrations
         (tenant_id, provider, access_token_encrypted, refresh_token_encrypted, realm_id, status)
       VALUES ($1, 'quickbooks', 'enc-a', 'enc-a', 'realm-a', 'active')`,
      [a.tenantId]
    );
    await pool.query(
      `INSERT INTO accounting_integrations
         (tenant_id, provider, access_token_encrypted, refresh_token_encrypted, realm_id, status)
       VALUES ($1, 'quickbooks', 'enc-b', 'enc-b', 'realm-b', 'active')`,
      [b.tenantId]
    );
    // Disconnected integration must be excluded by the status filter.
    await pool.query(
      `INSERT INTO accounting_integrations
         (tenant_id, provider, access_token_encrypted, refresh_token_encrypted, realm_id, status)
       VALUES ($1, 'quickbooks', 'enc-c', 'enc-c', 'realm-c', 'disconnected')`,
      [c.tenantId]
    );

    const repo = new PgAccountingIntegrationRepository(rlsPool);
    // Cross-tenant by design: sees BOTH active tenants (would be 0 before the fix).
    const active = await repo.findAllActive();
    const tenantIds = active.map((i) => i.tenantId);
    expect(tenantIds).toContain(a.tenantId);
    expect(tenantIds).toContain(b.tenantId);
    expect(tenantIds).not.toContain(c.tenantId);
  });
});
