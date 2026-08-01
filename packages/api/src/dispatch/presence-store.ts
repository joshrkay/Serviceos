/**
 * Dispatch-board presence store (UC-3, scale-to-1000).
 *
 * Tracks which users are viewing/dragging on a (tenant, board-date). Two
 * implementations behind one async interface, following the connection-registry
 * pattern (ws/connection-registry.ts):
 *
 * - `InMemoryDispatchPresenceStore` — the process-local Map, byte-identical to
 *   the pre-UC-3 behavior. The default when `REDIS_URL` is unset; correct for a
 *   single replica.
 * - `RedisDispatchPresenceStore` (redis-presence-store.ts) — cluster-wide
 *   presence shared across replicas. Entries carry an `expiresAt` lease so a
 *   crashed replica's/client's presence self-expires (the U3b lease/TTL
 *   stance); fails open to a per-replica local store on a Redis error.
 *
 * `upsert()` resolves `true` only when the VISIBLE state changed (new user,
 * mode, appointment, or name — not a pure TTL refresh). Callers publish
 * `presence_updated` only on change, so steady-state heartbeats stop fanning
 * out into a board refetch per viewer per beat (the N×QPS amplifier).
 */

export type PresenceMode = 'viewing' | 'dragging';

export interface PresenceEntry {
  tenantId: string;
  date: string;
  userId: string;
  displayName: string;
  appointmentId: string | null;
  mode: PresenceMode;
  expiresAt: number;
}

export type PresenceUpsert = Omit<PresenceEntry, 'expiresAt'> & { ttlMs?: number };

/** Default heartbeat lease — outlives the 5s WS heartbeat comfortably. */
export const DEFAULT_PRESENCE_TTL_MS = 15_000;

export interface DispatchPresenceStore {
  /** Upsert a heartbeat. Resolves true when the visible state changed. */
  upsert(entry: PresenceUpsert): Promise<boolean>;
  /** Remove a user's presence. Resolves true when an entry was removed. */
  clear(tenantId: string, date: string, userId: string): Promise<boolean>;
  /** Active (non-expired) presence for a board date. */
  list(tenantId: string, date: string): Promise<PresenceEntry[]>;
}

function entryKey(tenantId: string, date: string, userId: string): string {
  return `${tenantId}:${date}:${userId}`;
}

/** True when the entry differs in what other dispatchers can SEE. */
export function presenceVisiblyChanged(
  prev: Pick<PresenceEntry, 'displayName' | 'appointmentId' | 'mode'> | null,
  next: Pick<PresenceEntry, 'displayName' | 'appointmentId' | 'mode'>,
): boolean {
  if (!prev) return true;
  return (
    prev.mode !== next.mode ||
    prev.appointmentId !== next.appointmentId ||
    prev.displayName !== next.displayName
  );
}

/** Process-local store — the REDIS_URL-unset default (single-replica correct). */
export class InMemoryDispatchPresenceStore implements DispatchPresenceStore {
  private readonly store = new Map<string, PresenceEntry>();

  async upsert(entry: PresenceUpsert): Promise<boolean> {
    const ttlMs = entry.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    const key = entryKey(entry.tenantId, entry.date, entry.userId);
    const now = Date.now();
    const existing = this.store.get(key);
    const prev = existing && existing.expiresAt > now ? existing : null;
    this.store.set(key, {
      tenantId: entry.tenantId,
      date: entry.date,
      userId: entry.userId,
      displayName: entry.displayName,
      appointmentId: entry.appointmentId,
      mode: entry.mode,
      expiresAt: now + ttlMs,
    });
    return presenceVisiblyChanged(prev, entry);
  }

  async clear(tenantId: string, date: string, userId: string): Promise<boolean> {
    return this.store.delete(entryKey(tenantId, date, userId));
  }

  async list(tenantId: string, date: string): Promise<PresenceEntry[]> {
    const now = Date.now();
    const prefix = `${tenantId}:${date}:`;
    const active: PresenceEntry[] = [];
    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        continue;
      }
      active.push(entry);
    }
    return active;
  }
}

/**
 * Delegating store that starts in-memory and swaps to Redis once the
 * connection is established — mirrors the connection-registry's sync-return +
 * async-upgrade so the (synchronous) composition root stays unchanged. Entries
 * written during the brief upgrade window live in-memory and simply expire;
 * presence is advisory UI state, so a sub-second per-replica window at boot is
 * acceptable.
 */
class SwappableDispatchPresenceStore implements DispatchPresenceStore {
  private impl: DispatchPresenceStore = new InMemoryDispatchPresenceStore();
  swap(next: DispatchPresenceStore): void {
    this.impl = next;
  }
  upsert(entry: PresenceUpsert): Promise<boolean> {
    return this.impl.upsert(entry);
  }
  clear(tenantId: string, date: string, userId: string): Promise<boolean> {
    return this.impl.clear(tenantId, date, userId);
  }
  list(tenantId: string, date: string): Promise<PresenceEntry[]> {
    return this.impl.list(tenantId, date);
  }
}

/**
 * Select the store by REDIS_URL. Returns SYNCHRONOUSLY (InMemory) and, when
 * REDIS_URL is set, upgrades to the cluster-wide Redis store in the background
 * (falling back to InMemory if the connect fails). Byte-identical to InMemory
 * when REDIS_URL is unset.
 */
export function createDispatchPresenceStore(redisUrl?: string): DispatchPresenceStore {
  if (!redisUrl) return new InMemoryDispatchPresenceStore();
  const store = new SwappableDispatchPresenceStore();
  void import('./redis-presence-store')
    .then(({ createRedisDispatchPresenceStore }) => createRedisDispatchPresenceStore(redisUrl))
    .then((redisStore) => {
      if (redisStore) store.swap(redisStore);
    })
    .catch(() => {
      // Redis unavailable — stay in-memory (per-replica presence).
    });
  return store;
}

// ─── Process-wide singleton ─────────────────────────────────────────────────

let activeStore: DispatchPresenceStore | null = null;

/** Wire the store at boot (app.ts). Passing no URL keeps the in-memory store. */
export function initDispatchPresenceStore(redisUrl?: string): DispatchPresenceStore {
  activeStore = createDispatchPresenceStore(redisUrl);
  return activeStore;
}

/** Default process-wide store; lazily in-memory when init was never called. */
export function getDispatchPresenceStore(): DispatchPresenceStore {
  if (!activeStore) activeStore = new InMemoryDispatchPresenceStore();
  return activeStore;
}

/** Test hook — drop the singleton so suites don't bleed into each other. */
export function resetDispatchPresenceStoreForTests(): void {
  activeStore = null;
}

// ─── Convenience wrappers (route/query call sites) ──────────────────────────

export function upsertDispatchPresence(entry: PresenceUpsert): Promise<boolean> {
  return getDispatchPresenceStore().upsert(entry);
}

export function clearDispatchPresence(
  tenantId: string,
  date: string,
  userId: string,
): Promise<boolean> {
  return getDispatchPresenceStore().clear(tenantId, date, userId);
}

export function listDispatchPresence(tenantId: string, date: string): Promise<PresenceEntry[]> {
  return getDispatchPresenceStore().list(tenantId, date);
}

/**
 * Pure lookup over an already-fetched presence list — board-query fetches the
 * date's presence ONCE and derives per-appointment `editing` from it (one
 * store read per board query instead of one per appointment).
 */
export function findEditingOnAppointment(
  entries: PresenceEntry[],
  appointmentId: string,
  excludeUserId?: string,
): { userId: string; displayName: string; mode: PresenceMode } | null {
  for (const entry of entries) {
    if (entry.appointmentId !== appointmentId) continue;
    if (entry.mode !== 'dragging') continue;
    if (excludeUserId && entry.userId === excludeUserId) continue;
    return { userId: entry.userId, displayName: entry.displayName, mode: entry.mode };
  }
  return null;
}
