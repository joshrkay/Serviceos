/**
 * Runtime RLS-FORCE catalog property test (Track B3 / D — tenant isolation).
 *
 * `test/db/schema.test.ts` proves, by parsing the migration SQL *text*, that
 * every table declaring a `tenant_id` column also FORCEs RLS. That is a strong
 * STATIC guard — but it cannot catch a migration that says the right thing yet
 * fails to take effect at runtime: an ordering bug, an `ALTER TABLE IF EXISTS`
 * that silently no-ops against a renamed table, a later DROP that removes FORCE,
 * or a table created by a code path the text parser doesn't see.
 *
 * This suite closes that gap by querying the LIVE pg_catalog of the actually-
 * migrated database. It is catalog-driven, so it automatically covers all
 * ~116 tenant-scoped tables AND any table a future migration adds — no per-table
 * maintenance. It is the runtime complement to the static schema.test.ts guard
 * and to the fixture-based RV-003 leak suite (tenant-isolation.leak.test.ts).
 *
 * The two documented, backstopped exemptions (oauth_states,
 * platform_deprovision_log — see schema.ts migrations 218/219) are asserted to
 * be EXACTLY those two, so the exemption set can never silently grow at runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getSharedTestDb, closeSharedTestDb } from './shared';

// Mirrors RLS_EXEMPT_TABLES in test/db/schema.test.ts and the rationale in
// schema.ts migration 218 (documented, and backstopped by migration 219 which
// revokes the app-runtime role's grant on any tenant_id-without-RLS table).
const RLS_EXEMPT_TABLES = new Set<string>([
  'oauth_states',
  'platform_deprovision_log',
]);

interface TableRls {
  table: string;
  rowsecurity: boolean;
  forced: boolean;
}

describe('RLS FORCE — runtime catalog property (every tenant_id table)', () => {
  let pool: Pool;
  let tenantTables: TableRls[];

  beforeAll(async () => {
    pool = await getSharedTestDb();
    // Every base table in `public` that carries a tenant_id column, joined to
    // its pg_class RLS flags. This is the ground truth of the migrated DB.
    const res = await pool.query<TableRls>(
      `SELECT c.relname                AS table,
              c.relrowsecurity         AS rowsecurity,
              c.relforcerowsecurity    AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        WHERE c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = c.relname
               AND col.column_name = 'tenant_id'
          )
        ORDER BY c.relname`,
    );
    tenantTables = res.rows;
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('discovers a substantial set of tenant-scoped tables (sanity: migrations applied)', () => {
    // Guards against a false green if the catalog query silently returned 0
    // rows (e.g. schema not migrated) — the assertions below would be vacuous.
    expect(tenantTables.length).toBeGreaterThan(80);
  });

  it('every tenant_id table (except the two documented exemptions) has RLS ENABLED and FORCED at runtime', () => {
    const offenders = tenantTables
      .filter((t) => !RLS_EXEMPT_TABLES.has(t.table))
      .filter((t) => !t.rowsecurity || !t.forced)
      .map((t) => `${t.table} (rowsecurity=${t.rowsecurity}, forced=${t.forced})`);

    expect(
      offenders,
      `Tables with tenant_id but RLS not ENABLED+FORCED in the live catalog: ${offenders.join(
        ', ',
      )}. A tenant-path query under the NOBYPASSRLS app role would read EVERY tenant's rows — a cross-tenant leak. Add a migration: ALTER TABLE <t> ENABLE ROW LEVEL SECURITY; ALTER TABLE <t> FORCE ROW LEVEL SECURITY; + a tenant_isolation policy.`,
    ).toEqual([]);
  });

  it('the runtime exemption set is EXACTLY the two documented tables (never silently grows)', () => {
    const runtimeExempt = tenantTables
      .filter((t) => !t.forced)
      .map((t) => t.table)
      .sort();
    // Any tenant_id table that is not forced at runtime must be one of the two
    // known, documented exemptions — nothing else.
    expect(runtimeExempt).toEqual([...RLS_EXEMPT_TABLES].sort());
  });

  it('each documented exemption really exists in the catalog with a tenant_id column', () => {
    // Prevents the exemption list from masking a typo (e.g. exempting a table
    // that no longer exists while a real leak hides under the old name).
    const present = new Set(tenantTables.map((t) => t.table));
    for (const exempt of RLS_EXEMPT_TABLES) {
      expect(present.has(exempt), `${exempt} should exist with a tenant_id column`).toBe(true);
    }
  });
});
