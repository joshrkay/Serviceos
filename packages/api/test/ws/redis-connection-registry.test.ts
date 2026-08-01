import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisConnectionRegistry } from '../../src/ws/redis-connection-registry';

/**
 * U3b — RedisConnectionRegistry with a scripted `eval` (ioredis-mock can't run
 * Lua/TIME faithfully — the REAL atomic cap is proven by the Docker two-instance
 * integration test). These pin the registry's handling of the Lua result and,
 * critically, FAIL-OPEN-TO-LOCAL: a Redis outage must degrade to a per-replica
 * cap, never to unlimited.
 */
function fakeRedis(evalImpl: (...args: unknown[]) => Promise<unknown>): Redis {
  return {
    eval: vi.fn(evalImpl),
    zrem: vi.fn(async () => 1),
  } as unknown as Redis;
}

describe('RedisConnectionRegistry', () => {
  it('returns a lease when the Lua accepts (1)', async () => {
    const redis = fakeRedis(async () => 1);
    const reg = new RedisConnectionRegistry(redis, { perTenantMax: 5 });
    expect(await reg.acquire('s', 't1')).not.toBeNull();
    expect(redis.eval).toHaveBeenCalled();
  });

  it('returns null when the Lua rejects (0 = at cluster-wide cap)', async () => {
    const redis = fakeRedis(async () => 0);
    const reg = new RedisConnectionRegistry(redis, { perTenantMax: 5 });
    expect(await reg.acquire('s', 't1')).toBeNull();
  });

  it('release ZREMs the member and refresh re-evals', async () => {
    const redis = fakeRedis(async () => 1);
    const reg = new RedisConnectionRegistry(redis, { perTenantMax: 5 });
    const lease = await reg.acquire('s', 't1');
    await lease!.refresh();
    await lease!.release();
    expect(redis.zrem).toHaveBeenCalled();
    expect((redis.eval as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('FAILS OPEN TO LOCAL when Redis throws — a per-replica cap, never unlimited', async () => {
    const redis = fakeRedis(async () => {
      throw new Error('redis down');
    });
    const reg = new RedisConnectionRegistry(redis, { perTenantMax: 1 });
    expect(await reg.acquire('s', 't1')).not.toBeNull(); // degrades to local
    expect(await reg.acquire('s', 't1')).toBeNull(); // local cap still enforced (=1)
  });

  it('count returns the Lua count, or the local count on a Redis error', async () => {
    expect(await new RedisConnectionRegistry(fakeRedis(async () => 3)).count('s', 't1')).toBe(3);
    expect(
      await new RedisConnectionRegistry(
        fakeRedis(async () => {
          throw new Error('down');
        }),
      ).count('s', 't1'),
    ).toBe(0);
  });
});
