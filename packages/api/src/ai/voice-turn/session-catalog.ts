/**
 * WS5 — per-session tenant-catalog preload for in-call grounded quoting.
 *
 * Grounding a spoken estimate against the tenant catalog needs the active
 * catalog IN HAND at quote time, synchronously, on a live call. Loading it
 * from the DB mid-turn would add latency to the caller's turn. Instead we
 * kick the load off ONCE at session establishment (both the Gather and the
 * media-stream inbound paths) and stash the in-flight promise on the session
 * object — by quote time (many seconds of conversation later) it has almost
 * always resolved, so the read is free.
 *
 * The promise is stored on the mutable `VoiceSession` (GC'd with the session
 * when the store drops it — no separate cache to leak). Design assumption:
 * trades catalogs are small (1-5 person shops), so we take the active items
 * as-is with no pagination.
 */
import type { CatalogItem, CatalogItemRepository } from '../../catalog/catalog-item';
import type { VoiceSession } from '../agents/customer-calling/voice-session-store';

/** Default await budget at quote time before we degrade to "unavailable". */
export const CATALOG_RESOLVE_TIMEOUT_MS = 300;

/**
 * Kick off (once) the tenant-catalog load for this session and stash the
 * promise on `session.catalogPreload`. Idempotent: a second call while a
 * preload is already in flight (or resolved) is a no-op, so establishment
 * and a defensive quote-time call can't double-load. The promise never
 * rejects — a read failure resolves to `[]`, which `resolveSessionCatalog`
 * reports as "catalog unavailable" (safe, no fabricated prices).
 */
export function preloadSessionCatalog(
  session: VoiceSession,
  catalogRepo: CatalogItemRepository | undefined,
): void {
  if (!catalogRepo) return;
  if (session.catalogPreload) return;
  session.catalogPreload = catalogRepo
    .listByTenant(session.tenantId)
    .catch(() => [] as CatalogItem[]);
}

/**
 * Resolve the preloaded catalog for grounding, bounded by `timeoutMs`.
 * Returns the ACTIVE (non-archived) catalog items, or `null` when the
 * catalog is unavailable: no preload was started, it hasn't resolved within
 * the budget, it errored, or it came back empty. `null` is the caller's
 * signal to speak the no-number acknowledgment and treat every line as
 * uncatalogued — the turn is never blocked indefinitely, and a price is
 * never fabricated.
 */
export async function resolveSessionCatalog(
  session: VoiceSession,
  timeoutMs: number = CATALOG_RESOLVE_TIMEOUT_MS,
): Promise<CatalogItem[] | null> {
  const preload = session.catalogPreload;
  if (!preload) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  try {
    const items = await Promise.race([preload, timeout]);
    if (timer) clearTimeout(timer);
    if (!items) return null;
    const active = items.filter((i) => i.archivedAt === null);
    return active.length > 0 ? active : null;
  } catch {
    if (timer) clearTimeout(timer);
    return null;
  }
}
