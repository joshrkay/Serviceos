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
 * Unfiltered on purpose. Deprovisioning hard-deletes the tenant row
 * (`DELETE FROM tenants`, see `deprovision.ts`), so there is no lifecycle
 * column to exclude and every row here is a live tenant. If that ever becomes a
 * soft delete, this is the one place that has to learn about it — which is the
 * point of it being one place.
 */
export async function listAllTenantIds(pool: Pool | undefined | null): Promise<string[]> {
  // Sweeps are registered before the pool is known to exist (in-memory boots,
  // tests, `PROCESS_ROLE=web`). No pool means no tenants to sweep, not a crash.
  if (!pool) return [];
  const result = await pool.query('SELECT id FROM tenants');
  return result.rows.map((row: { id: string }) => row.id);
}
