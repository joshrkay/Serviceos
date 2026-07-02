import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisDispatchPresenceStore } from '../../src/dispatch/redis-presence-store';

/**
 * UC-3 — RedisDispatchPresenceStore with a scripted ioredis fake (the mocking
 * approach proven by redis-connection-registry.test.ts; cross-replica behavior
 * against a real Redis is exercised by the TEST_REDIS_URL-gated harness).
 * These pin the lease/TTL semantics, changed-detection, and — critically —
 * FAIL-OPEN-TO-LOCAL: a Redis outage degrades to per-replica presence, never
 * to a hard failure or silent loss of the feature.
 */

interface FakeRedisState {
  hashes: Map<string, Map<string, string>>;
}

function fakeRedis(overrides: Partial<Record<'hget' | 'hset' | 'hgetall' | 'hdel' | 'pexpire', (...args: never[]) => Promise<unknown>>> = {}) {
  const state: FakeRedisState = { hashes: new Map() };
  const hash = (key: string) => {
    let h = state.hashes.get(key);
    if (!h) {
      h = new Map();
      state.hashes.set(key, h);
    }
    return h;
  };
  const redis = {
    hget: vi.fn(async (key: string, field: string) => hash(key).get(field) ?? null),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      hash(key).set(field, value);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => Object.fromEntries(hash(key))),
    hdel: vi.fn(async (key: string, ...fields: string[]) => {
      let n = 0;
      for (const f of fields) if (hash(key).delete(f)) n++;
      return n;
    }),
    pexpire: vi.fn(async () => 1),
    ...overrides,
  };
  return { redis: redis as unknown as Redis, mocks: redis, state };
}

const ENTRY = {
  tenantId: 't1',
  date: '2026-05-20',
  userId: 'u1',
  displayName: 'Alex',
  appointmentId: null,
  mode: 'viewing' as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisDispatchPresenceStore', () => {
  it('writes the lease and re-ups the key TTL on every upsert', async () => {
    const { redis, mocks } = fakeRedis();
    const store = new RedisDispatchPresenceStore(redis);
    expect(await store.upsert({ ...ENTRY, ttlMs: 10_000 })).toBe(true);
    expect(mocks.hset).toHaveBeenCalledWith(
      'dispatch:presence:t1:2026-05-20',
      'u1',
      expect.stringContaining('"mode":"viewing"'),
    );
    expect(mocks.pexpire).toHaveBeenCalledWith('dispatch:presence:t1:2026-05-20', 30_000);
    const listed = await store.list('t1', '2026-05-20');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ tenantId: 't1', date: '2026-05-20', userId: 'u1' });
  });

  it('lease TTL expiry: expired entries are filtered from list and purged', async () => {
    vi.useFakeTimers();
    const { redis, mocks } = fakeRedis();
    const store = new RedisDispatchPresenceStore(redis);
    await store.upsert({ ...ENTRY, ttlMs: 1000 });
    expect(await store.list('t1', '2026-05-20')).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    expect(await store.list('t1', '2026-05-20')).toHaveLength(0);
    // best-effort purge of the expired field
    expect(mocks.hdel).toHaveBeenCalledWith('dispatch:presence:t1:2026-05-20', 'u1');
  });

  it('reports changed=false for a pure TTL refresh and true after expiry', async () => {
    vi.useFakeTimers();
    const store = new RedisDispatchPresenceStore(fakeRedis().redis);
    expect(await store.upsert({ ...ENTRY, ttlMs: 1000 })).toBe(true);
    expect(await store.upsert({ ...ENTRY, ttlMs: 1000 })).toBe(false); // heartbeat
    expect(await store.upsert({ ...ENTRY, ttlMs: 1000, mode: 'dragging' })).toBe(true);
    vi.advanceTimersByTime(1500);
    // previous lease lapsed — reappearing is a visible change
    expect(await store.upsert({ ...ENTRY, ttlMs: 1000, mode: 'dragging' })).toBe(true);
  });

  it('FAILS OPEN TO LOCAL when Redis throws — presence keeps working per replica', async () => {
    const down = async () => {
      throw new Error('redis down');
    };
    const { redis } = fakeRedis({ hget: down, hset: down, hgetall: down, hdel: down });
    const store = new RedisDispatchPresenceStore(redis);
    expect(await store.upsert(ENTRY)).toBe(true); // degraded to local, still works
    const listed = await store.list('t1', '2026-05-20'); // hgetall throws → local list
    expect(listed).toHaveLength(1);
    expect(listed[0].userId).toBe('u1');
    expect(await store.clear('t1', '2026-05-20', 'u1')).toBe(true); // local clear
    expect(await store.list('t1', '2026-05-20')).toHaveLength(0);
  });

  it('ignores malformed stored payloads instead of throwing', async () => {
    const { redis, state } = fakeRedis();
    state.hashes.set(
      'dispatch:presence:t1:2026-05-20',
      new Map([
        ['bad', 'not json{'],
        ['u2', JSON.stringify({ displayName: 'Sam', appointmentId: 'a1', mode: 'dragging', expiresAt: Date.now() + 60_000 })],
      ]),
    );
    const store = new RedisDispatchPresenceStore(redis);
    const listed = await store.list('t1', '2026-05-20');
    expect(listed).toHaveLength(1);
    expect(listed[0].userId).toBe('u2');
  });

  it('clear returns whether Redis removed an entry', async () => {
    const { redis } = fakeRedis();
    const store = new RedisDispatchPresenceStore(redis);
    await store.upsert(ENTRY);
    expect(await store.clear('t1', '2026-05-20', 'u1')).toBe(true);
    expect(await store.clear('t1', '2026-05-20', 'u1')).toBe(false);
  });
});
