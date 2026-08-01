import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisTenantQuotaStore } from '../../../src/ai/gateway/redis-tenant-quota';
import {
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
} from '../../../src/ai/gateway/tenant-quota';

/**
 * U3c — RedisTenantQuotaStore with a scripted `eval` (ioredis-mock can't run the
 * Lua/TIME the atomic quota relies on — the REAL cluster-wide cap + bucket are
 * proven by the TEST_REDIS_URL two-instance test). These pin the store's mapping
 * of the Lua result tuple to leases/errors and, critically, FAIL-OPEN-TO-LOCAL:
 * a Redis outage degrades to a per-replica quota, never unlimited, never closed.
 */
function fakeRedis(evalImpl: (...args: unknown[]) => Promise<unknown>): Redis {
  return { eval: vi.fn(evalImpl) } as unknown as Redis;
}

const acquire = (store: RedisTenantQuotaStore) =>
  store.acquire({ tenantId: 't1', tenantTier: 'standard', estimatedTokens: 10 });

describe('RedisTenantQuotaStore', () => {
  it('returns a lease when the Lua accepts (status 1)', async () => {
    // [status, reason, retryAfterMs, inFlight]
    const redis = fakeRedis(async () => [1, 0, 0, 1]);
    const store = new RedisTenantQuotaStore(redis);
    const lease = await acquire(store);
    expect(lease).toBeDefined();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws TenantConcurrencyExceededError on reason 1', async () => {
    const redis = fakeRedis(async () => [0, 1, 1000, 8]);
    const store = new RedisTenantQuotaStore(redis);
    await expect(acquire(store)).rejects.toBeInstanceOf(TenantConcurrencyExceededError);
  });

  it('throws TenantTokenBudgetExceededError on reason 2 with the Lua retryAfterMs', async () => {
    const redis = fakeRedis(async () => [0, 2, 4200, 3]);
    const store = new RedisTenantQuotaStore(redis);
    await expect(acquire(store)).rejects.toMatchObject({
      name: 'TenantTokenBudgetExceededError',
      retryAfterMs: 4200,
    });
  });

  it('throws TenantTokenBudgetExceededError on reason 3 (hard upper bound)', async () => {
    const redis = fakeRedis(async () => [0, 3, 1000, 3]);
    const store = new RedisTenantQuotaStore(redis);
    await expect(acquire(store)).rejects.toBeInstanceOf(TenantTokenBudgetExceededError);
  });

  it('release re-evals (ZREM + reconcile) and is idempotent', async () => {
    const evalFn = vi.fn(async () => [1, 0, 0, 1]);
    const store = new RedisTenantQuotaStore(fakeRedis(evalFn));
    const lease = await acquire(store);
    await lease.release(4, 6); // actuals → hasActuals=1
    await lease.release(4, 6); // idempotent — no second eval
    expect(evalFn).toHaveBeenCalledTimes(2); // 1 acquire + 1 release
  });

  it('FAILS OPEN TO LOCAL when Redis throws — a per-replica quota, never unlimited', async () => {
    const redis = fakeRedis(async () => {
      throw new Error('redis down');
    });
    // Local fallback tier: concurrency cap of 1 → first acquire ok, second rejects.
    const store = new RedisTenantQuotaStore(redis, {
      standard: {
        maxConcurrency: 1,
        bucketCapacity: 1000,
        refillTokensPerSec: 10,
        hardUpperBoundTokens: 100_000,
      },
    });
    const first = await acquire(store);
    expect(first).toBeDefined(); // degraded to local, still granted
    await expect(acquire(store)).rejects.toBeInstanceOf(TenantConcurrencyExceededError);
  });
});
