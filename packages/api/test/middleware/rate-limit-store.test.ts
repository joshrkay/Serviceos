import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Options } from 'express-rate-limit';

/**
 * U-P3c — RedisRateLimitStore with a scripted ioredis (ioredis-mock can't run the
 * INCR/PEXPIRE/PTTL Lua faithfully; the real cluster-wide counter is exercised by
 * the createRedisClient path in prod). These pin the store's mapping of the Lua
 * result to express-rate-limit's IncrementResponse and, critically,
 * FAIL-OPEN-TO-LOCAL: a Redis outage degrades to a per-replica MemoryStore, never
 * to unlimited and never to a thrown 500.
 */

// Mock createRedisClient so the store gets our scripted client synchronously-ish.
let nextClient: unknown = null;
vi.mock('../../src/redis/redis-client', () => ({
  createRedisClient: vi.fn(async () => nextClient),
  registerRedisClientForShutdown: vi.fn(),
}));

import {
  RedisRateLimitStore,
  createRateLimitStore,
  __resetRateLimitSharedClient,
} from '../../src/middleware/rate-limit-store';

const OPTS = { windowMs: 60_000 } as unknown as Options;

/**
 * Build a store wired to a scripted Redis client DETERMINISTICALLY: inject the
 * client directly AND prime nextClient to the same value, so the store's async
 * getSharedClient() resolution lands on the same client instead of racing the
 * direct assignment. No flush needed.
 */
function connectedStore(client: unknown, prefix = 'p:'): RedisRateLimitStore {
  nextClient = client;
  __resetRateLimitSharedClient();
  const store = new RedisRateLimitStore('redis://x', prefix);
  store.init(OPTS);
  (store as unknown as { redis: unknown }).redis = client;
  return store;
}

afterEach(() => {
  nextClient = null;
  __resetRateLimitSharedClient();
});

describe('RedisRateLimitStore', () => {
  it('increment maps the Lua [hits, pttl] to {totalHits, resetTime}', async () => {
    const redis = { eval: vi.fn(async () => [3, 45_000]) };
    const store = connectedStore(redis);

    const before = Date.now();
    const res = await store.increment('client-1');
    expect(res.totalHits).toBe(3);
    // resetTime ≈ now + pttl
    expect(res.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 45_000 - 50);
    expect(redis.eval).toHaveBeenCalledOnce();
    // key is prefixed
    expect(redis.eval.mock.calls[0][2]).toBe('p:client-1');
  });

  it('falls back to a FULL window when PTTL is negative (-2 missing / -1 no-expiry)', async () => {
    const redis = { eval: vi.fn(async () => [1, -2]) };
    const store = connectedStore(redis);
    const before = Date.now();
    const res = await store.increment('c');
    expect(res.totalHits).toBe(1);
    expect(res.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 50);
  });

  it('FAILS OPEN TO LOCAL when Redis eval throws — counts per-replica, never throws', async () => {
    const redis = {
      eval: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const store = connectedStore(redis);
    // It tries Redis, the eval throws, and it degrades to the per-replica
    // MemoryStore — returning a finite count WITHOUT throwing (never a hard 500,
    // never unlimited).
    const res = await store.increment('same');
    expect(redis.eval).toHaveBeenCalled(); // it DID try Redis first
    expect(res.totalHits).toBeGreaterThanOrEqual(1); // counted locally, not bypassed
    expect(res.resetTime).toBeInstanceOf(Date);
  });

  it('before the connection resolves, increments via the local store (no throw)', async () => {
    nextClient = { eval: vi.fn() };
    __resetRateLimitSharedClient();
    const store = new RedisRateLimitStore('redis://x', 'p:');
    store.init(OPTS);
    // Do NOT await the connection — redis is still null on this tick.
    const res = await store.increment('c');
    expect(res.totalHits).toBe(1);
    expect((nextClient as { eval: ReturnType<typeof vi.fn> }).eval).not.toHaveBeenCalled();
  });

  it('decrement and resetKey issue DECR / DEL on the prefixed key (best-effort)', async () => {
    const redis = {
      eval: vi.fn(async () => [1, 1000]),
      decr: vi.fn(async () => 0),
      del: vi.fn(async () => 1),
    };
    const store = connectedStore(redis, 'tenant:');
    await store.decrement('t1');
    await store.resetKey('t1');
    expect(redis.decr).toHaveBeenCalledWith('tenant:t1');
    expect(redis.del).toHaveBeenCalledWith('tenant:t1');
  });
});

describe('createRateLimitStore', () => {
  it('returns undefined when REDIS_URL is unset (express-rate-limit uses MemoryStore)', () => {
    expect(createRateLimitStore(undefined, 'api:')).toBeUndefined();
  });

  it('returns a RedisRateLimitStore when a URL is given', () => {
    __resetRateLimitSharedClient();
    nextClient = null;
    expect(createRateLimitStore('redis://x', 'api:')).toBeInstanceOf(RedisRateLimitStore);
  });
});
