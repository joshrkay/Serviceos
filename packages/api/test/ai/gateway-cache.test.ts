import {
  createCacheKey,
  InMemoryCacheStore,
  CachingGatewayWrapper,
} from '../../src/ai/gateway/cache';
import type { CacheConfig } from '../../src/ai/gateway/cache';
import { LLMGateway } from '../../src/ai/gateway/gateway';
import type { LLMProvider, LLMRequest, LLMGatewayConfig } from '../../src/ai/gateway/gateway';
import { StubProvider } from '../../src/ai/gateway/providers';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    taskType: 'summarize',
    messages: [{ role: 'user', content: 'Hello' }],
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
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig());

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
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig());

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
    }));

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
    }));

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
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig());

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
    const wrapper = new CachingGatewayWrapper(gateway, cacheStore, makeCacheConfig());

    const request = makeRequest({ taskType: 'summarize' });

    await expect(wrapper.complete(request)).rejects.toThrow();

    // Verify nothing was cached
    const key = createCacheKey(request);
    const cached = await cacheStore.get(key);
    expect(cached).toBeNull();
  });
});
