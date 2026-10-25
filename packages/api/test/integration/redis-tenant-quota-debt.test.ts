/**
 * GATEWAY-05 — RELEASE_LUA carries token debt, against a REAL Redis, on every
 * PR.
 *
 * `RedisTenantQuotaStore.release` reconciles an underestimate in RELEASE_LUA
 * (src/ai/gateway/redis-tenant-quota.ts): the overage is subtracted from the
 * shared bucket and carried as debt down to -bucketCapacity, the same as the
 * in-memory registry, instead of being forgiven at zero. ioredis-mock cannot
 * run EVAL/Lua with Redis TIME, so only a real Redis proves it (CLAUDE.md:
 * mocks are never the only proof).
 *
 * These cases used to sit in test/ai/gateway/redis-tenant-quota-two-instance.test.ts
 * behind `describe.skipIf(!TEST_REDIS_URL)`, which only the weekly
 * redis-multi-instance.yml sets. Here they bring their own Redis: TEST_REDIS_URL
 * when it is set, otherwise a `redis:7-alpine` testcontainer (the image the
 * integration suite already starts for dispatch-presence-redis.test.ts), so PR
 * CI's integration step runs them. Pinned by
 * test/ai/gateway/release-lua-debt-pr-ci.test.ts.
 *
 * Two ioredis connections stand in for two API replicas sharing one Redis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { RedisTenantQuotaStore } from '../../src/ai/gateway/redis-tenant-quota';
import {
  TenantTokenBudgetExceededError,
  type TenantQuotaTierConfig,
} from '../../src/ai/gateway/tenant-quota';

const tier = (over: Partial<TenantQuotaTierConfig>): Record<string, TenantQuotaTierConfig> => ({
  standard: {
    maxConcurrency: 100,
    bucketCapacity: 1_000_000,
    refillTokensPerSec: 1,
    hardUpperBoundTokens: 100_000_000,
    ...over,
  },
});

describe('Real Redis — RELEASE_LUA carries token debt across instances (GATEWAY-05)', () => {
  let container: StartedTestContainer | undefined;
  let a: Redis;
  let b: Redis;

  beforeAll(async () => {
    let url = process.env.TEST_REDIS_URL;
    if (!url) {
      container = await new GenericContainer('redis:7-alpine')
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start();
      url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    }
    a = new Redis(url);
    b = new Redis(url);
  });

  afterAll(async () => {
    await a?.quit();
    await b?.quit();
    await container?.stop();
  });

  it('carries an underestimate as debt (RELEASE_LUA) instead of forgiving it at 0', async () => {
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

  it('floors carried debt at -bucketCapacity in RELEASE_LUA', async () => {
    const tenantId = `t-${Date.now()}-debt-floor`;
    const cfg = tier({ maxConcurrency: 100, bucketCapacity: 100, refillTokensPerSec: 0.001 });
    const sa = new RedisTenantQuotaStore(a, cfg);

    const l1 = await sa.acquire({ tenantId, estimatedTokens: 10 });
    await l1.release(50_000, 50_000); // a vast overage
    const tokens = Number(await a.hget(`quota:tb:${tenantId}`, 'tokens'));
    expect(tokens).toBeGreaterThanOrEqual(-100);
    expect(tokens).toBeLessThan(-99);
  });
});
