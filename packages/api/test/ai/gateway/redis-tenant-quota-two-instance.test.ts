import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { RedisTenantQuotaStore } from '../../../src/ai/gateway/redis-tenant-quota';
import {
  TenantConcurrencyExceededError,
  TenantTokenBudgetExceededError,
  type TenantQuotaTierConfig,
} from '../../../src/ai/gateway/tenant-quota';

/**
 * U3c real proof — ioredis-mock cannot faithfully run the EVAL/Lua + Redis TIME +
 * ZADD/HSET the atomic quota relies on, so this is the ONLY test that proves the
 * cluster-wide concurrency cap, the shared token bucket, and the crashed-replica
 * TTL reclaim against a real Redis (CLAUDE.md: mocks are never the only proof).
 * Runs when TEST_REDIS_URL is set (CI provisions a Redis), skips otherwise.
 */
const REDIS_URL = process.env.TEST_REDIS_URL;

const tier = (over: Partial<TenantQuotaTierConfig>): Record<string, TenantQuotaTierConfig> => ({
  standard: {
    maxConcurrency: 100,
    bucketCapacity: 1_000_000,
    refillTokensPerSec: 1,
    hardUpperBoundTokens: 100_000_000,
    ...over,
  },
});

describe.skipIf(!REDIS_URL)('Redis tenant quota — two instances, one Redis', () => {
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

  it('enforces ONE shared concurrency cap across two store instances (not 2x)', async () => {
    const tenantId = `t-${Date.now()}-conc`;
    const cfg = tier({ maxConcurrency: 2 });
    const sa = new RedisTenantQuotaStore(a, cfg);
    const sb = new RedisTenantQuotaStore(b, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 1 });
    const l2 = await sb.acquire({ tenantId, estimatedTokens: 1 }); // other instance, shared Redis
    // cap is 2 cluster-wide → the 3rd is rejected on EITHER instance (not 2×2).
    await expect(sa.acquire({ tenantId, estimatedTokens: 1 })).rejects.toBeInstanceOf(
      TenantConcurrencyExceededError,
    );
    await expect(sb.acquire({ tenantId, estimatedTokens: 1 })).rejects.toBeInstanceOf(
      TenantConcurrencyExceededError,
    );

    await l1.release();
    // a slot freed → next acquire succeeds on either instance.
    const l3 = await sb.acquire({ tenantId, estimatedTokens: 1 });
    await l2.release();
    await l3.release();
  });

  it('shares ONE token bucket across instances — A draining it blocks B', async () => {
    const tenantId = `t-${Date.now()}-bucket`;
    // Big concurrency, tiny bucket, ~no refill → token budget is the binding cap.
    const cfg = tier({ maxConcurrency: 100, bucketCapacity: 100, refillTokensPerSec: 0.001 });
    const sa = new RedisTenantQuotaStore(a, cfg);
    const sb = new RedisTenantQuotaStore(b, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 90 }); // drains bucket to ~10
    await expect(sb.acquire({ tenantId, estimatedTokens: 50 })).rejects.toBeInstanceOf(
      TenantTokenBudgetExceededError,
    );
    await l1.release(); // no actuals → no reconcile; bucket stays drained
  });

  it('refunds the bucket on overestimate (reconcile) so a later call fits', async () => {
    const tenantId = `t-${Date.now()}-refund`;
    const cfg = tier({ maxConcurrency: 100, bucketCapacity: 100, refillTokensPerSec: 0.001 });
    const sa = new RedisTenantQuotaStore(a, cfg);
    const sb = new RedisTenantQuotaStore(b, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 90 }); // reserve 90, bucket ~10
    await l1.release(5, 5); // actual = 10 → refund 80; bucket back to ~90
    // B (other instance) now sees the refunded bucket and a 70-token call fits.
    const l2 = await sb.acquire({ tenantId, estimatedTokens: 70 });
    await l2.release();
  });

  it('carries an underestimate as debt (RELEASE_LUA) instead of forgiving it at 0 (GATEWAY-05)', async () => {
    const tenantId = `t-${Date.now()}-debt`;
    // refill 10 tok/s so retryAfterMs exposes the bucket balance.
    const cfg = tier({ maxConcurrency: 100, bucketCapacity: 100, refillTokensPerSec: 10 });
    const sa = new RedisTenantQuotaStore(a, cfg);
    const sb = new RedisTenantQuotaStore(b, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 90 }); // bucket ~10
    await l1.release(100, 50); // actual 150 vs est 90 → 60 owed → bucket ~-50
    const tokens = Number(await a.hget(`quota:tb:${tenantId}`, 'tokens'));
    expect(tokens).toBeLessThan(-45);
    expect(tokens).toBeGreaterThan(-51);

    // The OTHER instance sees the debt: a 1-token call must wait for the debt
    // to refill (~5.1s at 10 tok/s), not the ~0.1s a zero floor implied.
    const err = await sb.acquire({ tenantId, estimatedTokens: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TenantTokenBudgetExceededError);
    expect((err as TenantTokenBudgetExceededError).retryAfterMs).toBeGreaterThan(4_500);
  });

  it('floors carried debt at -bucketCapacity in RELEASE_LUA (GATEWAY-05)', async () => {
    const tenantId = `t-${Date.now()}-debt-floor`;
    const cfg = tier({ maxConcurrency: 100, bucketCapacity: 100, refillTokensPerSec: 0.001 });
    const sa = new RedisTenantQuotaStore(a, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 10 });
    await l1.release(50_000, 50_000); // a vast overage
    const tokens = Number(await a.hget(`quota:tb:${tenantId}`, 'tokens'));
    expect(tokens).toBeGreaterThanOrEqual(-100);
    expect(tokens).toBeLessThan(-99);
  });

  it('reclaims an orphaned (crashed-replica) concurrency slot via the lease TTL', async () => {
    const tenantId = `t-${Date.now()}-orphan`;
    const cfg = tier({ maxConcurrency: 1 });
    const store = new RedisTenantQuotaStore(a, cfg, 200); // 200ms lease TTL

    await store.acquire({ tenantId, estimatedTokens: 1 }); // never released (a crash)
    await expect(store.acquire({ tenantId, estimatedTokens: 1 })).rejects.toBeInstanceOf(
      TenantConcurrencyExceededError,
    );

    await new Promise((r) => setTimeout(r, 400)); // wait past the TTL
    const reclaimed = await store.acquire({ tenantId, estimatedTokens: 1 }); // slot self-expired
    await reclaimed.release();
  });
});
