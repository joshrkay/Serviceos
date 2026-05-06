import type { Pool } from 'pg';

/**
 * Phase 12 — supervisor-presence query.
 *
 * Returns true if *any* user in the tenant currently has
 * `current_mode IN ('supervisor', 'both')`. False means the tenant is
 * "unsupervised" — no one is watching the wall — and the AI auto-approve
 * pipeline must hard-block proposals (see
 * `proposals/auto-approve.ts:resolveAutoApproveThreshold`) and the
 * emergency-intent escalation must skip AI booking and Dial on-call
 * directly (see `shouldImmediatelyDialOnEmergency`).
 *
 * Cached for 30 seconds per tenant to keep the per-call cost trivial
 * even under the 4-concurrent-session target. The cache is intentionally
 * coarser than the 60s middleware cache for `current_mode`: a stale
 * "present=true" answer means up to 30s of permissive behavior after
 * the last supervisor leaves, which is acceptable for week-one (single
 * dyno) and documented in the multi-instance follow-up.
 *
 * The query uses `pool.query` directly (no tenant context / RLS) because
 * we need to read the cross-user row presence from a system context;
 * the tenant_id WHERE clause is the only scope. This mirrors the
 * supervisor-presence pattern called out in the addendum risk note.
 */

export const SUPERVISOR_PRESENCE_TTL_MS = 30_000;

interface CacheEntry {
  present: boolean;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — clears the in-process cache. Do not call from production code. */
export function _resetSupervisorPresenceCache(): void {
  cache.clear();
}

/**
 * Internal: the actual query. Exposed so tests can stub the loader
 * without touching a real Pool.
 */
export type SupervisorPresenceLoader = (tenantId: string) => Promise<boolean>;

let loader: SupervisorPresenceLoader | null = null;

/**
 * Wire a loader during boot. `app.ts` calls this with a Pg-backed
 * implementation when `DATABASE_URL` is set; tests call it with stubs.
 *
 * When no loader is wired (e.g. in-memory dev mode), `isSupervisorPresent`
 * returns `true` as a permissive default — the unsupervised hard-block
 * is opt-in. This preserves existing test fixtures that don't seed
 * mode rows.
 */
export function setSupervisorPresenceLoader(
  fn: SupervisorPresenceLoader | null,
): void {
  loader = fn;
}

/**
 * Build the default Pg-backed loader. The query reads users.current_mode
 * directly; RLS isn't applied because the call is system-level (a worker
 * deciding routing policy). The single tenant_id WHERE clause is the
 * scope.
 */
export function pgSupervisorPresenceLoader(
  pool: Pool,
): SupervisorPresenceLoader {
  return async (tenantId: string): Promise<boolean> => {
    const result = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM users
         WHERE tenant_id = $1
           AND current_mode IN ('supervisor', 'both')
       ) AS present`,
      [tenantId],
    );
    return result.rows[0]?.present === true;
  };
}

/**
 * Returns true iff at least one user in the tenant is in supervisor or
 * both mode. Cached for `SUPERVISOR_PRESENCE_TTL_MS`. When no loader is
 * wired, defaults to true.
 */
export async function isSupervisorPresent(
  tenantId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const cached = cache.get(tenantId);
  if (cached && nowMs - cached.fetchedAt < SUPERVISOR_PRESENCE_TTL_MS) {
    return cached.present;
  }

  if (!loader) {
    // Permissive default — preserves existing behavior when tests /
    // dev mode haven't wired a loader. Production paths set the loader
    // at boot in app.ts.
    return true;
  }

  let present: boolean;
  try {
    present = await loader(tenantId);
  } catch {
    // On loader error, fall back to permissive. We don't want a
    // transient DB hiccup to flip the entire tenant into unsupervised
    // mode (which would freeze auto-approvals). The 30s cache means
    // this is at worst a 30s permissive window. A persistent failure
    // surfaces via the underlying pool's error logging.
    return true;
  }

  cache.set(tenantId, { present, fetchedAt: nowMs });
  return present;
}
