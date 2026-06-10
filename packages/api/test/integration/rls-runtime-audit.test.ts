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

  it('cross-tenant SELECT through the tenant GUC returns zero rows', async () => {
    const pool = await getSharedTestDb();
    // Pick a representative high-value table that definitely exists.
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.current_tenant_id', gen_random_uuid()::text, false)`);
      const res = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(res.rows[0].n).toBe(0);
    } finally {
      await client.query(`SELECT set_config('app.current_tenant_id', '', false)`).catch(() => {});
      client.release();
    }
  });
});
