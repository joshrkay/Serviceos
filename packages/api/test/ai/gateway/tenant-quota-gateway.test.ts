/**
 * GATEWAY-01 — per-tenant quota rejections leave the gateway as typed 429s,
 * the tier table is env-sizable, and leaked Redis leases are reclaimed in
 * about a minute, not five.
 *
 * Before: TenantConcurrencyExceededError extended plain Error, so the gateway
 * re-wrapped it as AppError('LLM_PROVIDER_ERROR', 502) — dropping its code and
 * retryAfterMs. The voice path filed quota exhaustion as a provider fault and
 * the in-app audit's CLASSIFIER_QUOTA_CODES could never match.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { LLMGateway } from '../../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { composeResilienceStack } from '../../../src/ai/gateway/compose-resilience';
import {
  DEFAULT_TIER_CONFIG,
  TenantQuotaRegistry,
  resolveQuotaTierConfig,
  type TenantQuotaTierConfig,
} from '../../../src/ai/gateway/tenant-quota';
import {
  DEFAULT_QUOTA_LEASE_TTL_MS,
  RedisTenantQuotaStore,
} from '../../../src/ai/gateway/redis-tenant-quota';
import { MAX_GATEWAY_DEADLINE_MS } from '../../../src/ai/gateway/deadline';
import { createLLMGateway } from '../../../src/ai/gateway/factory';
import { classifyInfraFailure } from '../../../src/ai/voice-turn/classify-infra-failure';
import { AppError } from '../../../src/shared/errors';
import type { AppConfig } from '../../../src/shared/config';

class SlowProvider implements LLMProvider {
  readonly name = 'api.openai.com';
  requests: LLMRequest[] = [];
  constructor(private readonly delayMs: number) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      content: '{"intentType":"unknown"}',
      model: 'gpt-4o-mini',
      provider: this.name,
      tokenUsage: { input: 10, output: 2, total: 12 },
      latencyMs: this.delayMs,
    };
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function gatewayOver(provider: LLMProvider, tiers: Record<string, TenantQuotaTierConfig>) {
  const stack = composeResilienceStack(provider, { quota: new TenantQuotaRegistry(tiers) });
  return new LLMGateway({ defaultProvider: stack.name }, new Map([[stack.name, stack]]));
}

function classify(tenantId = 'tenant-A'): LLMRequest {
  return {
    taskType: 'classify_intent',
    tenantId,
    messages: [{ role: 'user', content: 'can you come out tuesday' }],
  };
}

function withClassifier(over: Partial<TenantQuotaTierConfig>): Record<string, TenantQuotaTierConfig> {
  return {
    ...DEFAULT_TIER_CONFIG,
    classifier_standard: { ...DEFAULT_TIER_CONFIG.classifier_standard, ...over },
  };
}

describe('GATEWAY-01 — quota rejections are typed 429s through the real gateway', () => {
  it('a concurrency rejection keeps code + retryAfterMs and status 429', async () => {
    const gateway = gatewayOver(new SlowProvider(300), withClassifier({ maxConcurrency: 2 }));

    const results = await Promise.allSettled([
      gateway.complete(classify()),
      gateway.complete(classify()),
      gateway.complete(classify()),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    const err = rejected[0].reason as AppError & { retryAfterMs?: number };
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('TENANT_CONCURRENCY_EXCEEDED');
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.details?.retryAfterMs).toBe(err.retryAfterMs);
    // Voice path files it as quota, not as "the provider is broken".
    expect(classifyInfraFailure(err)).toBe('quota_concurrency');
  });

  it('a token-bucket rejection keeps its code + the computed retryAfterMs', async () => {
    const gateway = gatewayOver(
      new SlowProvider(1),
      withClassifier({ bucketCapacity: 1, refillTokensPerSec: 1 }),
    );
    const err = (await gateway.complete(classify()).catch((e: unknown) => e)) as AppError & {
      retryAfterMs?: number;
    };
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('TENANT_TOKEN_BUDGET_EXCEEDED');
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterMs).toBeGreaterThan(1_000);
    expect(classifyInfraFailure(err)).toBe('quota_budget');
  });
});

describe('GATEWAY-01 — classifier concurrency default', () => {
  it('lets a tenant run more than two classify calls at once by default', async () => {
    const gateway = gatewayOver(new SlowProvider(150), DEFAULT_TIER_CONFIG);
    const results = await Promise.allSettled(
      Array.from({ length: DEFAULT_TIER_CONFIG.classifier_standard.maxConcurrency }, () =>
        gateway.complete(classify()),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(DEFAULT_TIER_CONFIG.classifier_standard.maxConcurrency).toBe(8);
  });

  it('keeps the classifier tiers ordered free <= standard <= premium', () => {
    const c = (t: string) => DEFAULT_TIER_CONFIG[t].maxConcurrency;
    expect(c('classifier_free')).toBeLessThanOrEqual(c('classifier_standard'));
    expect(c('classifier_standard')).toBeLessThanOrEqual(c('classifier_premium'));
  });
});

describe('GATEWAY-01 — AI_QUOTA_TIERS_JSON', () => {
  it('returns the defaults when unset or blank', () => {
    expect(resolveQuotaTierConfig({})).toEqual(DEFAULT_TIER_CONFIG);
    expect(resolveQuotaTierConfig({ AI_QUOTA_TIERS_JSON: '  ' })).toEqual(DEFAULT_TIER_CONFIG);
  });

  it('merges a partial override of a known tier over its defaults', () => {
    const tiers = resolveQuotaTierConfig({
      AI_QUOTA_TIERS_JSON: '{"classifier_standard":{"maxConcurrency":16}}',
    });
    expect(tiers.classifier_standard).toEqual({
      ...DEFAULT_TIER_CONFIG.classifier_standard,
      maxConcurrency: 16,
    });
    expect(tiers.standard).toEqual(DEFAULT_TIER_CONFIG.standard);
  });

  it('accepts a complete new tier', () => {
    const tiers = resolveQuotaTierConfig({
      AI_QUOTA_TIERS_JSON: JSON.stringify({
        classifier_enterprise: {
          maxConcurrency: 24,
          bucketCapacity: 2_000_000,
          refillTokensPerSec: 8_000,
          hardUpperBoundTokens: 6_000_000,
        },
      }),
    });
    expect(tiers.classifier_enterprise.maxConcurrency).toBe(24);
  });

  it.each([
    ['not JSON', '{classifier_standard:'],
    ['not an object', '[1,2]'],
    ['a negative limit', '{"classifier_standard":{"maxConcurrency":-1}}'],
    ['a fractional concurrency', '{"standard":{"maxConcurrency":2.5}}'],
    ['an unknown field', '{"standard":{"maxConcurency":4}}'],
    ['an incomplete NEW tier', '{"enterprise":{"maxConcurrency":40}}'],
  ])('fails loudly on %s', (_label, raw) => {
    expect(() => resolveQuotaTierConfig({ AI_QUOTA_TIERS_JSON: raw })).toThrow(
      /AI_QUOTA_TIERS_JSON/,
    );
  });

  describe('factory wiring', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...originalEnv };
    });
    const cfg = {
      NODE_ENV: 'test',
      AI_PROVIDER_API_KEY: 'sk-test',
      AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      AI_DEFAULT_MODEL: 'gpt-4o-mini',
    } as unknown as AppConfig;

    it('refuses to build the gateway (boot fails) on an invalid table', () => {
      delete process.env.REDIS_URL;
      process.env.AI_QUOTA_TIERS_JSON = '{"standard":{"maxConcurrency":0}}';
      expect(() => createLLMGateway(cfg)).toThrow(/AI_QUOTA_TIERS_JSON/);
    });

    it('builds the quota store from the env table', () => {
      delete process.env.REDIS_URL;
      process.env.AI_QUOTA_TIERS_JSON = '{"classifier_standard":{"maxConcurrency":11}}';
      const gateway = createLLMGateway(cfg);
      const outermost = [
        ...(gateway as unknown as { providers: Map<string, unknown> }).providers.values(),
      ][0] as { registry: { tiers: Record<string, TenantQuotaTierConfig> } };
      expect(outermost.registry.tiers.classifier_standard.maxConcurrency).toBe(11);
    });
  });
});

describe('GATEWAY-01 — Redis lease TTL is derived from the gateway deadline ceiling', () => {
  it('is just above the longest possible hold, not five minutes', () => {
    expect(DEFAULT_QUOTA_LEASE_TTL_MS).toBeGreaterThan(MAX_GATEWAY_DEADLINE_MS);
    expect(DEFAULT_QUOTA_LEASE_TTL_MS).toBeLessThanOrEqual(MAX_GATEWAY_DEADLINE_MS + 10_000);
    expect(DEFAULT_QUOTA_LEASE_TTL_MS).toBeLessThan(5 * 60 * 1000);
  });

  it('passes that TTL to the acquire script by default', async () => {
    const evalFn = vi.fn(async () => [1, 0, 0, 1]);
    const store = new RedisTenantQuotaStore({ eval: evalFn } as unknown as Redis);
    await store.acquire({ tenantId: 't1', estimatedTokens: 10 });
    // eval(script, numKeys, k1, k2, leaseTtlMs, ...)
    expect((evalFn.mock.calls[0] as unknown[])[4]).toBe(String(DEFAULT_QUOTA_LEASE_TTL_MS));
  });

  it('clamps a caller deadline to the ceiling, so the hold is bounded', async () => {
    const provider = new SlowProvider(1);
    const stack = composeResilienceStack(provider);
    await stack.complete({ ...classify(), deadlineMs: 10 * 60 * 1000 });
    expect(provider.requests[0].deadlineMs).toBeLessThanOrEqual(MAX_GATEWAY_DEADLINE_MS);
  });

  it('settles at the deadline even when a provider ignores its abort signal', async () => {
    const deaf: LLMProvider = {
      name: 'deaf',
      complete: () => new Promise<LLMResponse>(() => {}),
      isAvailable: async () => true,
    };
    const started = Date.now();
    const err = await composeResilienceStack(deaf)
      .complete({ ...classify(), deadlineMs: 300 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(Date.now() - started).toBeLessThan(800);
  });
});
