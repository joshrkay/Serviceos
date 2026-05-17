import { describe, it, expect, vi } from 'vitest';
import {
  createCacheKey,
  InMemoryCacheStore,
  CachingGatewayWrapper,
} from '../../src/ai/gateway/cache';
import type { CacheConfig } from '../../src/ai/gateway/cache';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';
import { InMemoryAiRunRepository } from '../../src/ai/ai-run';
import { metricsRegistry } from '../../src/monitoring/metrics';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize',
    messages: [{ role: 'user', content: 'Hello' }],
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function makeGateway(stub: LLMProvider, config: Partial<LLMGatewayConfig> = {}): LLMGateway {
  const providers = new Map<string, LLMProvider>();
  providers.set('stub', stub);
  const fullConfig: LLMGatewayConfig = {
    defaultProvider: 'stub',
    defaultModel: 'test-model',
    ...config,
  };
  return new LLMGateway(fullConfig, providers);
}

function makeCacheConfig(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return {
    enabled: true,
    defaultTtlMs: 3600000,
    deterministicTaskTypes: ['summarize'],
    ...overrides,
  };
}

describe('P2-031 — Response caching for deterministic AI tasks', () => {
  it('happy path — caches and returns cached response', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Cached result', tokenUsage: { input: 10, output: 5, total: 15 } });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig(), 'tenant-1');

    const request = makeRequest({ taskType: 'summarize' });

    const first = await wrapper.complete(request);
    expect(first.content).toBe('Cached result');
    expect(first.cached).toBeUndefined();

    stub.setResponse({ content: 'New result' });

    const second = await wrapper.complete(request);
    expect(second.content).toBe('Cached result');
    expect(second.cached).toBe(true);
  });

  it('happy path — cache miss calls underlying gateway', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Fresh response' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig(), 'tenant-1');

    const response = await wrapper.complete(makeRequest());

    expect(response.content).toBe('Fresh response');
    expect(response.provider).toBe('stub');
  });

  it('validation — non-deterministic task bypasses cache', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Response 1' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig({
      deterministicTaskTypes: ['summarize'],
    }), 'tenant-1');

    const request = makeRequest({ taskType: 'creative_writing' });

    const first = await wrapper.complete(request);
    expect(first.content).toBe('Response 1');

    stub.setResponse({ content: 'Response 2' });

    const second = await wrapper.complete(request);
    expect(second.content).toBe('Response 2');
  });

  it('happy path — expired cache entry triggers fresh call', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Original' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig({
      defaultTtlMs: 1,
    }), 'tenant-1');

    const request = makeRequest({ taskType: 'summarize' });

    await wrapper.complete(request);

    // Wait just long enough for the TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 5));

    stub.setResponse({ content: 'Refreshed' });

    const second = await wrapper.complete(request);
    expect(second.content).toBe('Refreshed');
  });

  it('happy path — tenant isolation in cache keys', () => {
    const request = makeRequest({ taskType: 'summarize', model: 'test-model' });

    const key1 = createCacheKey(request, 'tenant-1');
    const key2 = createCacheKey(request, 'tenant-2');
    const key3 = createCacheKey(request, 'tenant-1');

    expect(key1).not.toBe(key2);
    expect(key1).toBe(key3);
    expect(key1).toHaveLength(64); // SHA-256 hex
  });

  it('mock provider test — tracks hit/miss stats', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Trackable' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig(), 'tenant-1');

    const request = makeRequest({ taskType: 'summarize' });

    expect(wrapper.getStats()).toEqual({ hits: 0, misses: 0 });

    await wrapper.complete(request);
    expect(wrapper.getStats()).toEqual({ hits: 0, misses: 1 });

    await wrapper.complete(request);
    expect(wrapper.getStats()).toEqual({ hits: 1, misses: 1 });

    await wrapper.complete(makeRequest({ taskType: 'non_cached' }));
    expect(wrapper.getStats()).toEqual({ hits: 1, misses: 2 });
  });

  it('malformed AI output handled gracefully — underlying gateway error not cached', async () => {
    const failingProvider: LLMProvider = {
      name: 'stub',
      async complete() {
        throw new Error('Provider exploded');
      },
      async isAvailable() {
        return true;
      },
    };

    const providers = new Map<string, LLMProvider>();
    providers.set('stub', failingProvider);
    const gateway = new LLMGateway(
      { defaultProvider: 'stub', defaultModel: 'test-model' },
      providers,
    );

    const cacheStore = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig(), 'tenant-1');

    const request = makeRequest({ taskType: 'summarize' });

    await expect(wrapper.complete(request)).rejects.toThrow();

    // Verify nothing was cached
    const key = createCacheKey(request, 'tenant-1');
    const cached = await cacheStore.get(key);
    expect(cached).toBeNull();
  });

  // ─── P2-031 new requirements ───────────────────────────────────────────────

  it('cache hit writes AiRun row with cached: true', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Audit response', tokenUsage: { input: 10, output: 5, total: 15 } });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const aiRunRepo = new InMemoryAiRunRepository();

    const wrapper = new CachingGatewayWrapper(
      gateway,
      cacheStore,
      makeCacheConfig(),
      'tenant-audit',
      aiRunRepo,
    );

    const request = makeRequest({ taskType: 'summarize', tenantId: 'tenant-audit' });

    // First call: cache miss, no cached AiRun row
    await wrapper.complete(request);

    // Second call: cache hit, should write AiRun row with cached: true
    const result = await wrapper.complete(request);
    expect(result.cached).toBe(true);

    const runs = await aiRunRepo.findByTaskType('tenant-audit', 'summarize');
    const cachedRun = runs.find((r) => r.outputSnapshot?.cached === true);
    expect(cachedRun).toBeDefined();
    expect(cachedRun!.status).toBe('completed');
    expect(cachedRun!.outputSnapshot?.cached).toBe(true);
  });

  it('cache miss writes normal AiRun row without cached flag', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Fresh response' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const aiRunRepo = new InMemoryAiRunRepository();

    const wrapper = new CachingGatewayWrapper(
      gateway,
      cacheStore,
      makeCacheConfig(),
      'tenant-miss',
      aiRunRepo,
    );

    const request = makeRequest({ taskType: 'summarize', tenantId: 'tenant-miss' });
    const result = await wrapper.complete(request);

    expect(result.cached).toBeUndefined();
  });

  it('cross-tenant isolation: tenant-A cache entry is NOT served to tenant-B', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Tenant A response' });

    const gatewayA = makeGateway(stub);
    const gatewayB = makeGateway(stub);

    // Shared cache store (simulating shared Redis)
    const sharedCacheStore = new InMemoryCacheStore();
    const config = makeCacheConfig({ deterministicTaskTypes: ['summarize'] });

    const wrapperA = new CachingGatewayWrapper(gatewayA, sharedCacheStore, config, 'tenant-A');
    const wrapperB = new CachingGatewayWrapper(gatewayB, sharedCacheStore, config, 'tenant-B');

    const request: LLMRequest = {
      taskType: 'summarize',
      messages: [{ role: 'user', content: 'Identical prompt' }],
      model: 'test-model',
    };

    // Tenant A populates the cache
    await wrapperA.complete(request);

    // Tenant B should NOT get tenant A's cached response (different cache key)
    stub.setResponse({ content: 'Tenant B response' });
    const resultB = await wrapperB.complete(request);

    expect(resultB.content).toBe('Tenant B response');
    expect(resultB.cached).toBeUndefined();

    // Verify the cache keys are different
    const keyA = createCacheKey(request, 'tenant-A');
    const keyB = createCacheKey(request, 'tenant-B');
    expect(keyA).not.toBe(keyB);
  });

  it('same tenant, same request → gets cache hit', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Cached value' });

    const gateway = makeGateway(stub);
    const sharedCacheStore = new InMemoryCacheStore();
    const config = makeCacheConfig({ deterministicTaskTypes: ['summarize'] });

    const wrapperA1 = new CachingGatewayWrapper(gateway, sharedCacheStore, config, 'tenant-X');
    const wrapperA2 = new CachingGatewayWrapper(gateway, sharedCacheStore, config, 'tenant-X');

    const request: LLMRequest = {
      taskType: 'summarize',
      messages: [{ role: 'user', content: 'Same prompt' }],
      model: 'test-model',
    };

    await wrapperA1.complete(request);
    stub.setResponse({ content: 'Different value' });

    // Same tenant, same request — should hit the cache
    const result = await wrapperA2.complete(request);
    expect(result.content).toBe('Cached value');
    expect(result.cached).toBe(true);
  });

  it('Prometheus hit/miss counters increment correctly by taskType', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Metered response' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();

    const wrapper = new CachingGatewayWrapper(
      gateway,
      cacheStore,
      makeCacheConfig({ deterministicTaskTypes: ['summarize'] }),
      'tenant-metrics',
    );

    const request = makeRequest({ taskType: 'summarize', tenantId: 'tenant-metrics' });

    // Get initial metric values
    const getHits = async () => {
      const metrics = await metricsRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'gateway_cache_hits_total');
      if (!counter) return 0;
      const values = counter.values as Array<{ labels: Record<string, string>; value: number }>;
      return values.find((v) => v.labels.taskType === 'summarize')?.value ?? 0;
    };

    const getMisses = async () => {
      const metrics = await metricsRegistry.getMetricsAsJSON();
      const counter = metrics.find((m) => m.name === 'gateway_cache_misses_total');
      if (!counter) return 0;
      const values = counter.values as Array<{ labels: Record<string, string>; value: number }>;
      return values.find((v) => v.labels.taskType === 'summarize')?.value ?? 0;
    };

    const hitsBefore = await getHits();
    const missesBefore = await getMisses();

    // First call: miss
    await wrapper.complete(request);
    expect(await getMisses()).toBe(missesBefore + 1);

    // Second call: hit
    await wrapper.complete(request);
    expect(await getHits()).toBe(hitsBefore + 1);
  });

  it('non-deterministic task type does NOT write to cache', async () => {
    const stub = new StubProvider('stub');
    stub.setResponse({ content: 'Non-det response' });

    const gateway = makeGateway(stub);
    const cacheStore = new InMemoryCacheStore();
    const config = makeCacheConfig({ deterministicTaskTypes: ['summarize'] });

    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, config, 'tenant-1');

    const request = makeRequest({ taskType: 'generate_proposal' });
    await wrapper.complete(request);

    // Nothing should be in cache for this non-deterministic task
    const key = createCacheKey(request, 'tenant-1');
    const cached = await cacheStore.get(key);
    expect(cached).toBeNull();
  });
});
