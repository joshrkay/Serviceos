import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { RedisConnectionRegistry } from '../../src/ws/redis-connection-registry';

/**
 * U3b real proof — ioredis-mock cannot faithfully run the EVAL/Lua + Redis TIME
 * + ZADD/EXPIRE the atomic cap relies on, so this is the ONLY test that proves
 * the cluster-wide cap and the crashed-replica TTL reclaim against a real Redis
 * (CLAUDE.md: mocks are never the only proof). It runs when TEST_REDIS_URL is
 * set (CI provisions a Redis) and skips otherwise.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS_URL)('Redis WS connection cap — two instances, one Redis', () => {
  let a: Redis;
  let b: Redis;

  beforeAll(() => {
    a = new Redis(REDIS_URL!);
    b = new Redis(REDIS_URL!);
  });
  afterAll(async () => {
    await a?.quit();
    await b?.quit();
  });

  it('enforces ONE shared cap across two registry instances (not 2x)', async () => {
    const tenant = `t-${Date.now()}-shared`;
    const regA = new RedisConnectionRegistry(a, { perTenantMax: 2 });
    const regB = new RedisConnectionRegistry(b, { perTenantMax: 2 });

    const l1 = await regA.acquire('s', tenant);
    const l2 = await regB.acquire('s', tenant); // different instance, shared Redis
    expect(l1).not.toBeNull();
    expect(l2).not.toBeNull();

    // cap is 2 cluster-wide → the 3rd is rejected on EITHER instance (not 2×2).
    expect(await regA.acquire('s', tenant)).toBeNull();
    expect(await regB.acquire('s', tenant)).toBeNull();
    expect(await regA.count('s', tenant)).toBe(2);

    await l1!.release();
    await l2!.release();
    expect(await regA.count('s', tenant)).toBe(0);
  });

  it('reclaims an orphaned (crashed-replica) slot via the lease TTL', async () => {
    const tenant = `t-${Date.now()}-orphan`;
    const reg = new RedisConnectionRegistry(a, { perTenantMax: 1 }, 200); // 200ms lease TTL

    const orphan = await reg.acquire('s', tenant); // never released, never refreshed (a crash)
    expect(orphan).not.toBeNull();
    expect(await reg.acquire('s', tenant)).toBeNull(); // at cap while the lease lives

    await new Promise((r) => setTimeout(r, 400)); // wait past the TTL
    expect(await reg.acquire('s', tenant)).not.toBeNull(); // slot self-expired → reclaimable
  });
});
