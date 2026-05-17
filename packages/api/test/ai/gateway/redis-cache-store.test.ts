/**
 * P2-031 — RedisCacheStore unit tests
 *
 * Tests use ioredis-mock to avoid a real Redis connection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisCacheStore } from '../../../src/ai/gateway/redis-cache-store';
import type { CacheEntry } from '../../../src/ai/gateway/cache';
import type { Redis } from 'ioredis';

function makeMockRedis(): Redis & {
  store: Map<string, string>;
  __expire: Map<string, number>;
} {
  const store = new Map<string, string>();
  const __expire = new Map<string, number>();

  const mock = {
    store,
    __expire,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
      store.set(key, value);
      // Support PX millisecond expiry: set(key, val, 'PX', ms)
      if (args[0] === 'PX' && typeof args[1] === 'number') {
        __expire.set(key, Date.now() + (args[1] as number));
      }
      return 'OK';
    },
    async del(key: string): Promise<number> {
      const existed = store.has(key);
      store.delete(key);
      __expire.delete(key);
      return existed ? 1 : 0;
    },
  } as unknown as Redis & { store: Map<string, string>; __expire: Map<string, number> };

  return mock;
}

function makeEntry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    response: {
      content: 'hello',
      model: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 10, output: 5, total: 15 },
      latencyMs: 100,
    },
    cachedAt: Date.now(),
    ttlMs: 3_600_000,
    ...overrides,
  };
}

describe('RedisCacheStore', () => {
  let redis: ReturnType<typeof makeMockRedis>;
  let store: RedisCacheStore;

  beforeEach(() => {
    redis = makeMockRedis();
    store = new RedisCacheStore(redis);
  });

  it('round-trip: set then get returns the same entry', async () => {
    const entry = makeEntry();
    await store.set('key1', entry);
    const result = await store.get('key1');

    expect(result).not.toBeNull();
    expect(result!.response.content).toBe('hello');
    expect(result!.response.model).toBe('gpt-4o-mini');
    expect(result!.cachedAt).toBe(entry.cachedAt);
    expect(result!.ttlMs).toBe(entry.ttlMs);
  });

  it('get returns null for missing key', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('delete removes the key', async () => {
    const entry = makeEntry();
    await store.set('key-to-delete', entry);

    await store.delete('key-to-delete');

    const result = await store.get('key-to-delete');
    expect(result).toBeNull();
  });

  it('sets PX expiry matching ttlMs', async () => {
    const entry = makeEntry({ ttlMs: 5_000 });
    await store.set('expiry-key', entry);

    // The raw Redis call should have registered expiry
    const expiresAt = redis.__expire.get('expiry-key');
    expect(expiresAt).toBeDefined();
    // Should expire roughly 5 seconds from now (allow 500ms test slack)
    expect(expiresAt!).toBeGreaterThan(Date.now() + 4_000);
    expect(expiresAt!).toBeLessThan(Date.now() + 6_000);
  });

  it('JSON round-trip preserves full LLMResponse shape', async () => {
    const entry = makeEntry({
      response: {
        content: 'complex response',
        model: 'claude-3-opus',
        provider: 'anthropic',
        tokenUsage: { input: 500, output: 200, total: 700 },
        latencyMs: 1500,
        cached: false,
        degraded: false,
        providerPath: ['anthropic/claude-3-opus'],
      },
    });

    await store.set('complex-key', entry);
    const result = await store.get('complex-key');

    expect(result).not.toBeNull();
    expect(result!.response.content).toBe('complex response');
    expect(result!.response.tokenUsage).toEqual({ input: 500, output: 200, total: 700 });
    expect(result!.response.providerPath).toEqual(['anthropic/claude-3-opus']);
  });

  it('Redis get failure returns null without throwing (best-effort)', async () => {
    const brokenRedis = {
      async get(): Promise<string | null> {
        throw new Error('Redis connection refused');
      },
      async set(): Promise<'OK'> { return 'OK'; },
      async del(): Promise<number> { return 0; },
    } as unknown as Redis;

    const storeWithBrokenRedis = new RedisCacheStore(brokenRedis);
    const result = await storeWithBrokenRedis.get('any-key');
    expect(result).toBeNull();
  });

  it('Redis set failure is silent (best-effort)', async () => {
    const brokenRedis = {
      async get(): Promise<string | null> { return null; },
      async set(): Promise<'OK'> {
        throw new Error('Redis write failed');
      },
      async del(): Promise<number> { return 0; },
    } as unknown as Redis;

    const storeWithBrokenRedis = new RedisCacheStore(brokenRedis);
    // Should not throw
    await expect(storeWithBrokenRedis.set('key', makeEntry())).resolves.toBeUndefined();
  });

  it('Redis del failure is silent (best-effort)', async () => {
    const brokenRedis = {
      async get(): Promise<string | null> { return null; },
      async set(): Promise<'OK'> { return 'OK'; },
      async del(): Promise<number> {
        throw new Error('Redis del failed');
      },
    } as unknown as Redis;

    const storeWithBrokenRedis = new RedisCacheStore(brokenRedis);
    // Should not throw
    await expect(storeWithBrokenRedis.delete('key')).resolves.toBeUndefined();
  });

  it('handles malformed JSON in Redis gracefully', async () => {
    // Simulate corrupted data in Redis
    redis.store.set('corrupt-key', 'not-valid-json{{{');
    const result = await store.get('corrupt-key');
    expect(result).toBeNull();
  });
});
