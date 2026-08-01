/**
 * P2-031 — Redis-backed CacheStore implementation.
 *
 * Uses ioredis under the hood. On any Redis error, operations are
 * best-effort: get() returns null, set() and delete() are no-ops.
 * Cache failures MUST NOT propagate to the LLM call.
 */
import type { Redis } from 'ioredis';
import type { CacheEntry, CacheStore } from './cache';
import { createRedisClient } from '../../redis/redis-client';

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
    if (entry.ttlMs <= 0) {
      // No-op: zero/negative TTL would expire immediately or error in Redis.
      return;
    }
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

  async quit(): Promise<void> {
    await this.redis.quit();
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
  // U3a — reuse the shared client factory (proven fail-fast options, lazy
  // ioredis import). Returns null on unset URL or connect failure; the factory
  // then keeps the InMemoryCacheStore. The cache keeps its own shutdown
  // registration (factory.ts _cacheStoresToShutdown via RedisCacheStore.quit()),
  // so it is NOT double-registered with shutdownRedisClients.
  const client = await createRedisClient(redisUrl);
  if (!client) return null;
  return new RedisCacheStore(client);
}
