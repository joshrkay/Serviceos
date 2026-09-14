/**
 * P2-031 — factory cache wiring tests
 *
 * Verifies that createLLMGateway() correctly wraps or skips the cache layer
 * based on AI_CACHE_ENABLED and REDIS_URL environment variables.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppConfig } from '../../../src/shared/config';
import type { LLMGateway } from '../../../src/ai/gateway/gateway';
import type {
  LLMTraceCompletionEvent,
  LLMTraceExporter,
} from '../../../src/ai/gateway/trace-exporter';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    AI_PROVIDER_API_KEY: 'sk-test',
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    R2_BUCKET: 'serviceos-uploads',
    ...overrides,
  } as unknown as AppConfig;
}

describe('createLLMGateway — cache wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AI_CACHE_ENABLED;
    delete process.env.REDIS_URL;
    delete process.env.SHADOW_LLM_ENABLED;
    delete process.env.AI_LIGHTWEIGHT_MODEL;
    delete process.env.AI_STANDARD_MODEL;
    delete process.env.AI_COMPLEX_MODEL;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  it('AI_CACHE_ENABLED=false (default) — returns bare LLMGateway without cache wrapper', async () => {
    // AI_CACHE_ENABLED is NOT set
    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { LLMGateway } = await import('../../../src/ai/gateway/gateway');
    const { CachingGatewayWrapper } = await import('../../../src/ai/gateway/cache');

    const gateway = createLLMGateway(cfg());

    expect(gateway).toBeInstanceOf(LLMGateway);
    expect(gateway).not.toBeInstanceOf(CachingGatewayWrapper);
  });

  it('AI_CACHE_ENABLED=true without REDIS_URL — wraps with InMemoryCacheStore', async () => {
    process.env.AI_CACHE_ENABLED = 'true';
    // REDIS_URL is NOT set

    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { CachingGatewayWrapper } = await import('../../../src/ai/gateway/cache');

    const gateway = createLLMGateway(cfg());

    expect(gateway).toBeInstanceOf(CachingGatewayWrapper);
  });

  it('AI_CACHE_ENABLED=true with REDIS_URL — wraps with CachingGatewayWrapper (Redis upgrade is async)', async () => {
    process.env.AI_CACHE_ENABLED = 'true';
    process.env.REDIS_URL = 'redis://localhost:6379';

    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { CachingGatewayWrapper } = await import('../../../src/ai/gateway/cache');

    const gateway = createLLMGateway(cfg());

    // The wrapper is always a CachingGatewayWrapper; the Redis store is wired
    // asynchronously (so InMemory is used until Redis connects — best-effort).
    expect(gateway).toBeInstanceOf(CachingGatewayWrapper);
  });

  it('cache wrapper exposes complete() and is usable as a gateway', async () => {
    process.env.AI_CACHE_ENABLED = 'true';

    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const gateway = createLLMGateway(cfg());

    expect(typeof gateway.complete).toBe('function');
  });

  it('default deterministic task types are configured correctly', async () => {
    process.env.AI_CACHE_ENABLED = 'true';

    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { CachingGatewayWrapper } = await import('../../../src/ai/gateway/cache');

    const gateway = createLLMGateway(cfg());

    expect(gateway).toBeInstanceOf(CachingGatewayWrapper);
    const wrapper = gateway as unknown as { config: { deterministicTaskTypes: string[] } };
    const taskTypes = wrapper.config.deterministicTaskTypes;

    expect(taskTypes).toContain('classify_intent');
    expect(taskTypes).toContain('extract_categories');

    // Reconciled (follow-up #2): the idealized names that matched no real
    // gateway taskType were removed, and intent_classification → classify_intent
    // (the live classifier's actual taskType).
    expect(taskTypes).not.toContain('intent_classification');
    expect(taskTypes).not.toContain('entity_extraction');
    expect(taskTypes).not.toContain('transcript_normalization');

    // Non-deterministic types must NOT be in the list
    expect(taskTypes).not.toContain('draft_estimate');
    expect(taskTypes).not.toContain('generate_proposal');
  });

  // ── U10 — trace export from the cache-hit branch + factory threading ──────
  // Cache hits BYPASS gateway.complete (the wrapper returns the stored
  // response at cache.ts's hit branch), so the wrapper must export the hit
  // itself — the same gap writeAiRunForCacheHit closes for ai_runs.

  function noopExporter(): LLMTraceExporter {
    return { recordCompletion: () => {}, flush: async () => {} };
  }

  const cacheHitRequest = {
    taskType: 'classify_intent',
    tenantId: 'tenant-cache',
    messages: [{ role: 'user' as const, content: 'invoice Acme for the tune-up' }],
    metadata: { tenantId: 'tenant-cache', sessionId: 'voice-sess-3', promptVersionId: 'classify-v7' },
  };

  function fakeInnerGateway() {
    return {
      complete: vi.fn(async () => ({
        content: '{"intentType":"create_invoice"}',
        model: 'gpt-4o-mini',
        provider: 'openai',
        tokenUsage: { input: 10, output: 5, total: 15 },
        latencyMs: 12,
      })),
    };
  }

  it('cache hit → exporter receives one event with cached:true and the inner gateway is not called again', async () => {
    const { CachingGatewayWrapper, InMemoryCacheStore } = await import('../../../src/ai/gateway/cache');
    const inner = fakeInnerGateway();
    const events: LLMTraceCompletionEvent[] = [];
    const traceExporter: LLMTraceExporter = {
      recordCompletion: (e) => {
        events.push(e);
      },
      flush: async () => {},
    };
    const wrapper = new CachingGatewayWrapper(
      inner as unknown as LLMGateway,
      new InMemoryCacheStore(),
      { enabled: true, defaultTtlMs: 60_000, deterministicTaskTypes: ['classify_intent'] },
      'system',
      undefined,
      traceExporter,
    );

    const miss = await wrapper.complete(cacheHitRequest);
    const hit = await wrapper.complete(cacheHitRequest);

    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(miss.cached).toBeUndefined();
    expect(hit.cached).toBe(true);
    // The miss is exported by the inner gateway (a fake here, so nothing);
    // the hit never reaches it, so the wrapper exports exactly that one.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cached: true,
      degraded: false,
      tenantId: 'tenant-cache',
      taskType: 'classify_intent',
      sessionId: 'voice-sess-3',
      promptVersionId: 'classify-v7',
      servedModel: 'gpt-4o-mini',
      provider: 'openai',
      tokenUsage: { input: 10, output: 5, total: 15 },
      costMicroCents: 0,
      latencyMs: 0,
      output: '{"intentType":"create_invoice"}',
    });
    expect(typeof events[0].correlationId).toBe('string');
    expect(events[0].input).toEqual(cacheHitRequest.messages);
  });

  it('an exporter that throws on the hit branch never blocks the cached response', async () => {
    const { CachingGatewayWrapper, InMemoryCacheStore } = await import('../../../src/ai/gateway/cache');
    const inner = fakeInnerGateway();
    const wrapper = new CachingGatewayWrapper(
      inner as unknown as LLMGateway,
      new InMemoryCacheStore(),
      { enabled: true, defaultTtlMs: 60_000, deterministicTaskTypes: ['classify_intent'] },
      'system',
      undefined,
      {
        recordCompletion: () => {
          throw new Error('langfuse queue full');
        },
        flush: async () => {},
      },
    );

    await wrapper.complete(cacheHitRequest);
    const hit = await wrapper.complete(cacheHitRequest);

    expect(hit.cached).toBe(true);
    expect(hit.content).toBe('{"intentType":"create_invoice"}');
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  it('createLLMGateway(config, { traceExporter }) threads the exporter and is NOT coerced into a logger', async () => {
    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const traceExporter = noopExporter();

    const bare = createLLMGateway(cfg(), { traceExporter }) as unknown as {
      traceExporter?: unknown;
      logger?: unknown;
    };
    expect(bare.traceExporter).toBe(traceExporter);
    expect(bare.logger).toBeUndefined();

    process.env.AI_CACHE_ENABLED = 'true';
    const wrapped = createLLMGateway(cfg(), { traceExporter }) as unknown as {
      traceExporter?: unknown;
    };
    expect(wrapped.traceExporter).toBe(traceExporter);
  });

  it('createLLMGateway(config, { resilience }) is not coerced into a logger either', async () => {
    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const gateway = createLLMGateway(cfg(), { resilience: {} }) as unknown as { logger?: unknown };
    expect(gateway.logger).toBeUndefined();
  });
});
