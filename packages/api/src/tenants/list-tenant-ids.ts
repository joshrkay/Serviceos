import type { Pool } from 'pg';

/**
 * The tenant enumerator every per-tenant sweep runs on.
 *
 * This existed as fifteen inlined copies of the same three lines inside
 * `app.ts` — one per sweep — which meant the production selector had no name,
 * no single place to change, and (crucially) no way for a test to run the real
 * thing. Every sweep integration test stubbed `listTenantIds` to a hand-picked
 * one-element array, so the query below had never executed under test: the stub
 * replaced exactly the thing under test. See D-032 and PRD §11.0e.
 *
 * Deprovisioning hard-deletes the tenant row (`DELETE FROM tenants`, see
 * `deprovision.ts`), so there is no lifecycle column to exclude and every row
 * here is a live tenant. The one filter is the hidden tenants of the
 * pre-signup demo call (U7, migration 317): the demo pool (`demo`) and the
 * platform tenant that owns the demo visitor's rows (`platform`, D1). No
 * owner, billing or report sweep may ever visit one. If tenants ever become a
 * soft delete, this is the one place that has to learn about it — which is
 * the point of it being one place. Pinned by
 * test/integration/demo-tenants-excluded.test.ts.
 */
export async function listAllTenantIds(pool: Pool | undefined | null): Promise<string[]> {
  // Sweeps are registered before the pool is known to exist (in-memory boots,
  // tests, `PROCESS_ROLE=web`). No pool means no tenants to sweep, not a crash.
  if (!pool) return [];
  const result = await pool.query(
    'SELECT id FROM tenants WHERE demo = false AND platform = false',
  );
  return result.rows.map((row: { id: string }) => row.id);
}
