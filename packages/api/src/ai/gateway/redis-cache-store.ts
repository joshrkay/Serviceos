/**
 * P2-031 — Redis-backed CacheStore implementation.
 *
 * Uses ioredis under the hood. On any Redis error, operations are
 * best-effort: get() returns null, set() and delete() are no-ops.
 * Cache failures MUST NOT propagate to the LLM call.
 */
import type { Redis } from 'ioredis';
import type { CacheEntry, CacheStore } from './cache';

export class RedisCacheStore implements CacheStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(key: string): Promise<CacheEntry | null> {
    try {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    try {
      const serialized = JSON.stringify(entry);
      await this.redis.set(key, serialized, 'PX', entry.ttlMs);
    } catch {
      // Best-effort — swallow Redis errors silently
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      // Best-effort — swallow Redis errors silently
    }
  }
}

/**
 * Create a RedisCacheStore from a REDIS_URL connection string,
 * or return null if the URL is not set/empty.
 *
 * Callers should fall back to InMemoryCacheStore when this returns null.
 */
export async function createRedisCacheStore(
  redisUrl?: string,
): Promise<RedisCacheStore | null> {
  if (!redisUrl) return null;

  try {
    // Lazy import so ioredis is only loaded when Redis is actually configured.
    const { default: Redis } = await import('ioredis');
    const client = new Redis(redisUrl, {
      // Prevent ioredis from retrying forever if Redis is unavailable at startup.
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      // Fail fast on connect — cache unavailability must not stall boot.
      connectTimeout: 3000,
      lazyConnect: true,
    });

    await client.connect();
    return new RedisCacheStore(client);
  } catch {
    return null;
  }
}
