/**
 * Postgres integration — RLS runtime backstop through the PRODUCTION repo path.
 *
 * The sibling `rls-runtime-role.test.ts` proves the low-level
 * `applyTenantContext` *session* path enforces RLS. This file closes the
 * remaining gap: it drives a real `PgBaseRepository.withTenant(...)` call —
 * the exact code path every request and worker uses, which routes through
 * `withTenantTransaction` and issues a transaction-local `SET LOCAL ROLE
 * rls_app_runtime` when `RLS_RUNTIME_ROLE=true` — and proves that a query
 * that OMITS its app-layer `WHERE tenant_id = $1` filter STILL cannot read
 * another tenant's rows. That is the whole point of the backstop: a forgotten
 * filter can no longer cross tenants once the flag is on.
 *
 * It also pins the off-by-default contract: with the flag OFF the same
 * filter-less query — running as the superuser connection principal with no
 * SET ROLE — sees every tenant's rows, i.e. the DB backstop is inert and
 * production behavior is byte-for-byte unchanged (isolation still rests on the
 * app-layer filter, exactly as today).
 *
 * A mocked Pool can prove none of this — RLS only enforces against a real,
 * RLS-subject role in real Postgres.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { PgBaseRepository } from '../../src/db/pg-base';

let pool: Pool;
const ORIGINAL_FLAG = process.env.RLS_RUNTIME_ROLE;

/**
 * Minimal concrete repository exposing the protected `withTenant` so the test
 * exercises the production tenant-scoped path (transactional SET LOCAL config +
 * role) rather than re-implementing it.
 */
class ProbeRepository extends PgBaseRepository {
  /** Deliberately NO `WHERE tenant_id = $1` — relies solely on the DB backstop. */
  filterlessCustomerTenantIds(tenantId: string): Promise<string[]> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query<{ tenant_id: string }>('SELECT tenant_id FROM customers');
      return res.rows.map((r) => r.tenant_id);
    });
  }

  /** Filter-less lookup of a specific customer id — proves cross-tenant invisibility. */
  filterlessCustomerById(tenantId: string, id: string): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const res = await client.query('SELECT id FROM customers WHERE id = $1', [id]);
      return res.rowCount ?? 0;
    });
  }
}

let repo: ProbeRepository;
const createdTenantIds: string[] = [];

async function seedTenantWithCustomer(): Promise<{ tenantId: string; customerId: string }> {
  const { tenantId, userId } = await createTestTenant(pool);
  createdTenantIds.push(tenantId);
  const customerId = crypto.randomUUID();
  // Seeded as the superuser pool (bypasses RLS) — correct for fixture setup.
  await pool.query(
    `INSERT INTO customers (id, tenant_id, first_name, last_name, display_name, created_by)
     VALUES ($1, $2, 'Probe', 'Cust', 'Probe Cust', $3)`,
    [customerId, tenantId, userId],
  );
  return { tenantId, customerId };
}

beforeAll(async () => {
  pool = await getSharedTestDb();
  repo = new ProbeRepository(pool);
});

afterEach(() => {
  // Restore the flag between tests so one test's setting can't leak into another.
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
});

afterAll(async () => {
  if (ORIGINAL_FLAG === undefined) delete process.env.RLS_RUNTIME_ROLE;
  else process.env.RLS_RUNTIME_ROLE = ORIGINAL_FLAG;
  // Clean up only the rows this suite created (the verification DB is shared).
  for (const tenantId of createdTenantIds) {
    await pool.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
  }
  await closeSharedTestDb();
});

describe('RLS runtime backstop via PgBaseRepository.withTenant (real Postgres)', () => {
  it('flag ON: a filter-less repo query is blocked cross-tenant by RLS (only the active tenant is visible)', async () => {
    process.env.RLS_RUNTIME_ROLE = 'true';
    const a = await seedTenantWithCustomer();
    const b = await seedTenantWithCustomer();

    // withTenant(b) runs SET LOCAL ROLE rls_app_runtime + SET LOCAL
    // app.current_tenant_id = b, so the filter-less SELECT is scoped by RLS.
    const tenantIds = await repo.filterlessCustomerTenantIds(b.tenantId);
    expect(tenantIds.length).toBeGreaterThan(0);
    expect(tenantIds.every((t) => t === b.tenantId)).toBe(true);
    expect(tenantIds).not.toContain(a.tenantId);

    // Tenant A's customer is invisible even by direct id — no app-layer filter,
    // yet the DB refuses to return it.
    expect(await repo.filterlessCustomerById(b.tenantId, a.customerId)).toBe(0);
    // Same tenant still reads its own row (proves it's RLS scoping, not a broken grant).
    expect(await repo.filterlessCustomerById(b.tenantId, b.customerId)).toBe(1);
  });

  it('flag OFF (default): the same filter-less query sees every tenant — backstop inert, prod behavior unchanged', async () => {
    delete process.env.RLS_RUNTIME_ROLE;
    const a = await seedTenantWithCustomer();
    const b = await seedTenantWithCustomer();

    // No SET ROLE: the query runs as the superuser connection principal, so RLS
    // is bypassed and a filter-less SELECT returns other tenants' rows too.
    const seenFromB = await repo.filterlessCustomerById(b.tenantId, a.customerId);
    expect(seenFromB).toBe(1); // A's customer IS visible while scoped to B → no DB isolation

    const tenantIds = await repo.filterlessCustomerTenantIds(b.tenantId);
    expect(tenantIds).toContain(a.tenantId);
    expect(tenantIds).toContain(b.tenantId);
  });
});
