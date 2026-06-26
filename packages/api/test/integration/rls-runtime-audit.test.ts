/**
 * Runtime RLS audit (PR #525 senior review must-fix).
 *
 * The static schema test (test/db/schema.test.ts) proves the migration
 * SQL contains ENABLE + FORCE for every RLS table. This test goes one
 * level deeper and audits the LIVE database catalog after migrations:
 *
 *  1. Every table with a `tenant_id` column has `rowsecurity = true`.
 *  2. Every such table has `relforcerowsecurity = true` (owner cannot
 *     bypass — the Blocker-3 class of bug).
 *  3. Every such table has at least one policy in `pg_policies`.
 *
 * Any future migration that adds a tenant-scoped table without full RLS
 * fails here against the real catalog, not just string matching.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';

// Tables that legitimately carry a tenant_id column but are exempt from
// per-tenant RLS. Add here ONLY with a documented reason.
const EXEMPT_TABLES: string[] = [
  // Single-use OAuth nonce: /callback consumes the state row BEFORE any
  // tenant context exists — recovering tenant_id from the row is the
  // point of the lookup. See migration 085's exception comment.
  'oauth_states',
  // Platform-scope audit of tenant deletion: written while the tenant is
  // being destroyed and read by platform admins with no tenant context.
  // See migration 123.
  'platform_deprovision_log',
];

describe('runtime RLS audit — live pg catalog', () => {
  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function tenantTables(pool: Pool): Promise<string[]> {
    const res = await pool.query(`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public'
        AND c.column_name = 'tenant_id'
        AND t.table_type = 'BASE TABLE'
    `);
    return res.rows
      .map((r: { table_name: string }) => r.table_name)
      .filter((t: string) => !EXEMPT_TABLES.includes(t))
      .sort();
  }

  it('every tenant_id table has RLS enabled AND forced', async () => {
    const pool = await getSharedTestDb();
    const tables = await tenantTables(pool);
    expect(tables.length).toBeGreaterThan(30); // sanity: schema actually loaded

    const res = await pool.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    `);
    const byName = new Map<string, { relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      res.rows.map((r: any) => [r.relname, r]),
    );

    const notEnabled = tables.filter((t) => !byName.get(t)?.relrowsecurity);
    const notForced = tables.filter((t) => !byName.get(t)?.relforcerowsecurity);

    expect(notEnabled, `tables missing ENABLE ROW LEVEL SECURITY: ${notEnabled.join(', ')}`).toEqual([]);
    expect(notForced, `tables missing FORCE ROW LEVEL SECURITY: ${notForced.join(', ')}`).toEqual([]);
  });

  it('every tenant_id table has at least one policy in pg_policies', async () => {
    const pool = await getSharedTestDb();
    const tables = await tenantTables(pool);

    const res = await pool.query(
      `SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'`,
    );
    const withPolicy = new Set(res.rows.map((r: { tablename: string }) => r.tablename));

    const missing = tables.filter((t) => !withPolicy.has(t));
    expect(missing, `tenant tables with NO RLS policy: ${missing.join(', ')}`).toEqual([]);
  });

  it('rls_app_runtime holds no grant on any tenant_id table that lacks RLS (deny-list, migration 219)', async () => {
    // The exempt tables carry tenant_id but have no policy to scope them, so the
    // RLS-subject role must not be able to reach them at all — otherwise a
    // tenant-path query under the role would read EVERY tenant's rows.
    const pool = await getSharedTestDb();
    const res = await pool.query(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'rls_app_runtime' AND table_schema = 'public'
         AND table_name = ANY($1)`,
      [EXEMPT_TABLES],
    );
    expect(
      res.rows.map((r: { table_name: string; privilege_type: string }) => `${r.table_name}:${r.privilege_type}`),
      `rls_app_runtime must hold NO grant on the tenant_id-without-RLS tables, found: ${JSON.stringify(res.rows)}`,
    ).toEqual([]);
  });

  it('cross-tenant SELECT through the tenant GUC returns zero rows for a non-superuser', async () => {
    // The test pool connects as a superuser, and superusers bypass RLS
    // entirely (FORCE does not apply to them) — querying directly here
    // would either pass vacuously on an empty DB or see every tenant's
    // rows. Probe through a dedicated unprivileged role instead, exactly
    // like a least-privilege production app role.
    const pool = await getSharedTestDb();
    const client = await pool.connect();
    try {
      // Self-seed: a customer in a tenant the probe will NOT be scoped to,
      // so the zero-row assertion is meaningful even on an empty database.
      const { createTestTenant } = await import('./shared');
      const tenant = await createTestTenant(pool);
      const seededTenant = tenant.tenantId;
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, false)`,
        [seededTenant],
      );
      await client.query(
        `INSERT INTO customers (tenant_id, first_name, last_name, display_name, created_by)
         VALUES ($1, 'Probe', 'Customer', 'Probe Customer', 'rls-audit-test')`,
        [seededTenant],
      );

      await client.query(`
        DO $$ BEGIN
          CREATE ROLE rls_probe NOLOGIN;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      `);
      await client.query(`GRANT USAGE ON SCHEMA public TO rls_probe`);
      await client.query(`GRANT SELECT ON customers TO rls_probe`);

      // Scope the GUC to a DIFFERENT (random) tenant, drop privileges,
      // and assert the seeded row is invisible.
      await client.query(
        `SELECT set_config('app.current_tenant_id', gen_random_uuid()::text, false)`,
      );
      await client.query(`SET ROLE rls_probe`);
      const res = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(res.rows[0].n).toBe(0);

      // Sanity: scoped to the seeded tenant, the probe role CAN see it —
      // proves the zero above came from the policy, not a broken grant.
      await client.query(`RESET ROLE`);
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, false)`,
        [seededTenant],
      );
      await client.query(`SET ROLE rls_probe`);
      const scoped = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(scoped.rows[0].n).toBe(1);
    } finally {
      await client.query(`RESET ROLE`).catch(() => {});
      client.release();
    }
  });
});
