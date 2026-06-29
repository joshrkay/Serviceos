import { describe, it, expect, beforeAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';

/**
 * U2c gate — the tenant-context isolation property that makes the request hot
 * path safe under PgBouncer transaction-mode pooling.
 *
 * PgBouncer transaction mode reuses a server backend BETWEEN transactions, so a
 * leaked session GUC would expose the previous tenant to the next checkout. The
 * middleware (and withTenantTransaction) set the tenant id with
 * `set_config('app.current_tenant_id', $1, true)` — the `true` makes it
 * **transaction-local**, so Postgres auto-resets it at COMMIT/ROLLBACK. This
 * test pins that property against a real Postgres: the GUC is visible inside the
 * transaction and gone afterward, so a reused connection never inherits the
 * prior tenant.
 *
 * (Full RLS-policy enforcement under the rls_app_runtime role is covered by
 * test/integration/rls-tenant-isolation.test.ts; this test isolates the
 * transaction-scoping property specifically, with no role dependency.)
 *
 * Runs in PR CI via `npm run test:integration` (Docker-gated).
 */
describe('PgBouncer-safe tenant context (SET LOCAL is transaction-scoped)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = await getSharedTestDb();
  });

  async function readCtxInTransaction(tenantId: string): Promise<string | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const res = await client.query<{ ctx: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS ctx",
      );
      await client.query('COMMIT');
      return res.rows[0]?.ctx ?? null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function readCtxOutsideTransaction(): Promise<string | null> {
    const client = await pool.connect();
    try {
      // missing_ok=true → returns NULL/empty when the GUC was never set on this
      // backend (i.e. it did not leak from a prior transaction).
      const res = await client.query<{ ctx: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS ctx",
      );
      return res.rows[0]?.ctx ?? null;
    } finally {
      client.release();
    }
  }

  it('sets the tenant GUC inside the transaction and clears it at COMMIT (no leak across reuse)', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);

    // Tenant A's context is visible within its transaction.
    expect(await readCtxInTransaction(a.tenantId)).toBe(a.tenantId);

    // A fresh checkout (likely the same pooled backend) must NOT see tenant A —
    // SET LOCAL was reset at COMMIT. current_setting returns '' when unset.
    expect(await readCtxOutsideTransaction()).toBeFalsy();

    // Tenant B's transaction sees only B — never A's leaked context.
    expect(await readCtxInTransaction(b.tenantId)).toBe(b.tenantId);
  });

  it('interleaved tenant transactions never observe each other’s context', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);

    const [ctxA, ctxB] = await Promise.all([
      readCtxInTransaction(a.tenantId),
      readCtxInTransaction(b.tenantId),
    ]);

    expect(ctxA).toBe(a.tenantId);
    expect(ctxB).toBe(b.tenantId);
    expect(ctxA).not.toBe(ctxB);
  });
});
