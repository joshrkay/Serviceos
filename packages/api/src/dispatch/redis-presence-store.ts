/**
 * Redis-backed dispatch presence store (UC-3, scale-to-1000).
 *
 * One Redis HASH per (tenant, board-date) — field = userId, value = the JSON
 * presence payload including an `expiresAt` lease. Reads purge expired fields
 * best-effort; the hash key itself carries a PEXPIRE (3× the lease, re-upped on
 * every write, mirroring the U3b registry's key hygiene) so an abandoned board
 * date disappears even with no further reads.
 *
 * Unlike the connection cap (redis-connection-registry.ts) there is no
 * cluster-wide decision to race on — last write per user wins is exactly the
 * desired semantics — so plain HSET/HGETALL suffice and no atomic Lua is
 * needed. Lease expiry uses the writing replica's clock: presence is advisory
 * UI state, so second-level host skew is acceptable (the registry's Redis-TIME
 * Lua protects a hard cap; nothing hard depends on presence).
 *
 * Failure stance: FAIL-OPEN-TO-LOCAL (the registry's stance). On any Redis
 * error we degrade to a per-replica in-memory store — presence keeps working
 * on each replica rather than vanishing cluster-wide.
 */
import type { Redis } from 'ioredis';
import { createRedisClient, registerRedisClientForShutdown } from '../redis/redis-client';
import {
  DEFAULT_PRESENCE_TTL_MS,
  InMemoryDispatchPresenceStore,
  presenceVisiblyChanged,
  type DispatchPresenceStore,
  type PresenceEntry,
  type PresenceMode,
  type PresenceUpsert,
} from './presence-store';

interface StoredPresence {
  displayName: string;
  appointmentId: string | null;
  mode: PresenceMode;
  expiresAt: number;
}

function parseStored(raw: string): StoredPresence | null {
  try {
    const parsed = JSON.parse(raw) as StoredPresence;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.displayName !== 'string') return null;
    if (typeof parsed.expiresAt !== 'number') return null;
    if (parsed.mode !== 'viewing' && parsed.mode !== 'dragging') return null;
    return parsed;
  } catch {
    return null;
  }
}

export class RedisDispatchPresenceStore implements DispatchPresenceStore {
  /** Per-replica store used when Redis is unavailable (fail-open-to-local). */
  private readonly local = new InMemoryDispatchPresenceStore();

  constructor(private readonly redis: Redis) {}

  private key(tenantId: string, date: string): string {
    return `dispatch:presence:${tenantId}:${date}`;
  }

  async upsert(entry: PresenceUpsert): Promise<boolean> {
    const ttlMs = entry.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
    const key = this.key(entry.tenantId, entry.date);
    try {
      const now = Date.now();
      const prevRaw = await this.redis.hget(key, entry.userId);
      const stored: StoredPresence = {
        displayName: entry.displayName,
        appointmentId: entry.appointmentId,
        mode: entry.mode,
        expiresAt: now + ttlMs,
      };
      await this.redis.hset(key, entry.userId, JSON.stringify(stored));
      await this.redis.pexpire(key, ttlMs * 3);
      const prevStored = prevRaw ? parseStored(prevRaw) : null;
      const prev = prevStored && prevStored.expiresAt > now ? prevStored : null;
      return presenceVisiblyChanged(prev, entry);
    } catch {
      // Redis down — degrade to per-replica presence (never lose the feature).
      return this.local.upsert(entry);
    }
  }

  async clear(tenantId: string, date: string, userId: string): Promise<boolean> {
    try {
      const removed = await this.redis.hdel(this.key(tenantId, date), userId);
      return Number(removed) > 0;
    } catch {
      return this.local.clear(tenantId, date, userId);
    }
  }

  async list(tenantId: string, date: string): Promise<PresenceEntry[]> {
    const key = this.key(tenantId, date);
    try {
      const raw = await this.redis.hgetall(key);
      const now = Date.now();
      const active: PresenceEntry[] = [];
      const expired: string[] = [];
      for (const [userId, json] of Object.entries(raw)) {
        const stored = parseStored(json);
        if (!stored || stored.expiresAt <= now) {
          expired.push(userId);
          continue;
        }
        active.push({
          tenantId,
          date,
          userId,
          displayName: stored.displayName,
          appointmentId: stored.appointmentId,
          mode: stored.mode,
          expiresAt: stored.expiresAt,
        });
      }
      if (expired.length > 0) {
        // Best-effort purge — the lease already excludes them from every read.
        void this.redis.hdel(key, ...expired).catch(() => {});
      }
      return active;
    } catch {
      return this.local.list(tenantId, date);
    }
  }
}

/**
 * Build a RedisDispatchPresenceStore from REDIS_URL, or null when unset /
 * unreachable (caller stays in-memory). Registers the client for SIGTERM
 * shutdown.
 */
export async function createRedisDispatchPresenceStore(
  redisUrl?: string,
): Promise<RedisDispatchPresenceStore | null> {
  const client = await createRedisClient(redisUrl, { role: 'command' });
  if (!client) return null;
  registerRedisClientForShutdown(client);
  return new RedisDispatchPresenceStore(client);
}
