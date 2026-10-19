/**
 * U7 — is this tenant hidden from every owner, billing and analytics surface?
 *
 * A hidden tenant is a demo-pool tenant (`tenants.demo`) or the platform
 * tenant (`tenants.platform`, D1). Listers exclude them in SQL; surfaces that
 * receive one tenant id at a time (the product-analytics forward here, the
 * delivery boundary in S6-5) ask this check instead.
 *
 * One primary-key read per tenant id, cached for the process: the two flags
 * are written once, when the row is inserted (migration 317 for the platform
 * tenant, the pool seed for demo tenants), and never change, so a cached
 * answer cannot go stale. An unknown id is not hidden (and is not cached, so
 * a tenant inserted later is read fresh). A failed read throws and is not
 * cached: each caller decides how to fail closed.
 */
import type { Pool } from 'pg';

export type HiddenTenantCheck = (tenantId: string) => Promise<boolean>;

/** Bounded so a long-lived process cannot grow the cache without limit. */
const MAX_CACHED = 10_000;

export function createHiddenTenantCheck(pool: Pick<Pool, 'query'>): HiddenTenantCheck {
  const cache = new Map<string, boolean>();
  return async (tenantId) => {
    const known = cache.get(tenantId);
    if (known !== undefined) return known;
    const { rows } = await pool.query<{ hidden: boolean }>(
      `SELECT (demo OR platform) AS hidden FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const row = rows.at(0);
    if (!row) return false;
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(tenantId, row.hidden);
    return row.hidden;
  };
}
