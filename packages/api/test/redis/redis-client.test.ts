import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createRedisClient,
  registerRedisClientForShutdown,
  shutdownRedisClients,
} from '../../src/redis/redis-client';

// Hand-rolled ioredis fake (mirrors redis-cache-store.test.ts's approach —
// ioredis-mock's lazyConnect/connect() semantics are unreliable for asserting a
// successful connect). Captures constructed instances so we can pin the options.
const h = vi.hoisted(() => {
  const instances: Array<{ url: string; opts: Record<string, unknown> }> = [];
  class FakeRedis {
    store = new Map<string, string>();
    connected = false;
    constructor(
      public url: string,
      public opts: Record<string, unknown>,
    ) {
      instances.push(this);
    }
    async connect(): Promise<void> {
      if (this.url.includes('unreachable')) throw new Error('ECONNREFUSED');
      this.connected = true;
    }
    async set(k: string, v: string): Promise<string> {
      this.store.set(k, v);
      return 'OK';
    }
    async get(k: string): Promise<string | null> {
      return this.store.get(k) ?? null;
    }
    async quit(): Promise<string> {
      this.connected = false;
      return 'OK';
    }
  }
  return { FakeRedis, instances };
});

vi.mock('ioredis', () => ({ default: h.FakeRedis }));

beforeEach(() => {
  h.instances.length = 0;
});

describe('createRedisClient', () => {
  it('returns null when redisUrl is unset/empty — callers fall back to InMemory', async () => {
    expect(await createRedisClient(undefined)).toBeNull();
    expect(await createRedisClient('')).toBeNull();
    // No client constructed when the URL is falsy (off the cold-start path).
    expect(h.instances).toHaveLength(0);
  });

  it('connects and returns a working client when redisUrl is set', async () => {
    const client = await createRedisClient('redis://localhost:6379');
    expect(client).not.toBeNull();
    await client!.set('k', 'v');
    expect(await client!.get('k')).toBe('v');
  });

  it('passes the proven fail-fast options to ioredis', async () => {
    await createRedisClient('redis://localhost:6379');
    expect(h.instances).toHaveLength(1);
    expect(h.instances[0].opts).toMatchObject({
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      connectTimeout: 3000,
      lazyConnect: true,
    });
  });

  it('returns null (does not throw) when the connect fails', async () => {
    expect(await createRedisClient('redis://unreachable:6379')).toBeNull();
  });
});

describe('shutdownRedisClients', () => {
  it('quits every registered client once, swallows a rejecting quit, and drains the registry', async () => {
    const ok = { quit: vi.fn(async () => 'OK') };
    const bad = {
      quit: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    registerRedisClientForShutdown(ok);
    registerRedisClientForShutdown(bad);

    await expect(shutdownRedisClients()).resolves.toBeUndefined();
    expect(ok.quit).toHaveBeenCalledTimes(1);
    expect(bad.quit).toHaveBeenCalledTimes(1);

    // Registry drained — a second shutdown is a no-op (doesn't re-quit).
    await shutdownRedisClients();
    expect(ok.quit).toHaveBeenCalledTimes(1);
  });
});
