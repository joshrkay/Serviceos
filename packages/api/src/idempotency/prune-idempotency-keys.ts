import { IDEMPOTENCY_KEY_TTL_MS, type IdempotencyStore } from './idempotency-store';

export interface PruneIdempotencyKeysDeps {
  store: IdempotencyStore;
  tenantIds: readonly string[];
  now?: Date;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/**
 * #1489 — delete idempotency keys past their 24h TTL, tenant by tenant
 * (`idempotency_keys` is FORCE RLS, so there is no cross-tenant DELETE).
 * One tenant's failure is logged and does not stop the rest. Returns the
 * number of keys removed.
 */
export async function pruneExpiredIdempotencyKeys(deps: PruneIdempotencyKeysDeps): Promise<number> {
  const cutoff = new Date((deps.now ?? new Date()).getTime() - IDEMPOTENCY_KEY_TTL_MS);
  let pruned = 0;
  for (const tenantId of deps.tenantIds) {
    try {
      pruned += await deps.store.pruneExpired(tenantId, cutoff);
    } catch (err) {
      deps.logger?.warn('Idempotency-key prune failed', {
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return pruned;
}
