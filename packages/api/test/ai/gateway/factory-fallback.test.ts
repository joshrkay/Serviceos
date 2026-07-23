/**
 * FM-03 — factory wires AI_FALLBACK_PROVIDER_* into the resilience stack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildFallbackProvidersFromEnv,
  createLLMGateway,
} from '../../../src/ai/gateway/factory';
import { FallbackModelMapProvider } from '../../../src/ai/gateway/fallback-model-map';
import type { AppConfig } from '../../../src/shared/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';
import { composeResilienceStack } from '../../../src/ai/gateway/compose-resilience';
import { CircuitBreakerRegistry, DEFAULT_BREAKER } from '../../../src/ai/gateway/breaker';
import { TenantQuotaRegistry } from '../../../src/ai/gateway/tenant-quota';
import { AppError } from '../../../src/shared/errors';

function cfg(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    AI_PROVIDER_API_KEY: 'sk-primary',
    AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    R2_BUCKET: 'serviceos-uploads',
  } as unknown as AppConfig;
}

class ScriptedProvider implements LLMProvider {
  readonly name: string;
  calls: LLMRequest[] = [];
  constructor(
    name: string,
    private readonly impl: (req: LLMRequest) => Promise<LLMResponse>,
  ) {
    this.name = name;
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return this.impl(req);
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('buildFallbackProvidersFromEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AI_FALLBACK_PROVIDER_API_KEY;
    delete process.env.AI_FALLBACK_PROVIDER_BASE_URL;
    delete process.env.AI_FALLBACK_LIGHTWEIGHT_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty when fallback env is unset', () => {
    expect(buildFallbackProvidersFromEnv()).toEqual([]);
  });

  it('returns empty when only key is set', () => {
    expect(
      buildFallbackProvidersFromEnv(undefined, {
        AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
      }),
    ).toEqual([]);
  });

  it('returns one FallbackModelMapProvider when both key and URL are set', () => {
    const providers = buildFallbackProvidersFromEnv(undefined, {
      AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
      AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_FALLBACK_LIGHTWEIGHT_MODEL: 'meta-llama/llama-3.1-8b-instruct',
    });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(FallbackModelMapProvider);
    expect(providers[0].name).toBe('openrouter.ai');
  });
});

describe('createLLMGateway — fallbackProviders wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AI_FALLBACK_PROVIDER_API_KEY;
    delete process.env.AI_FALLBACK_PROVIDER_BASE_URL;
    delete process.env.SHADOW_LLM_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function failoverProviderCount(gateway: ReturnType<typeof createLLMGateway>): number {
    // TenantQuota → Failover → providers[]
    // @ts-expect-error reach into internals
    const outermost = [...gateway.providers.values()][0] as {
      inner?: { providers?: unknown[] };
    };
    return outermost.inner?.providers?.length ?? 0;
  }

  it('wires a single provider when fallback env is unset', () => {
    const gateway = createLLMGateway(cfg());
    expect(failoverProviderCount(gateway)).toBe(1);
  });

  it('wires two providers when AI_FALLBACK_PROVIDER_* both set', () => {
    process.env.AI_FALLBACK_PROVIDER_API_KEY = 'sk-or-test';
    process.env.AI_FALLBACK_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';
    const gateway = createLLMGateway(cfg());
    expect(failoverProviderCount(gateway)).toBe(2);
  });
});

describe('composeResilienceStack — primary abort fails over', () => {
  it('returns fallback response when primary aborts', async () => {
    const abortErr = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    const primary = new ScriptedProvider('primary', async () => {
      throw abortErr;
    });
    const fallback = new ScriptedProvider('fallback', async (req) => ({
      content: 'ok-from-fallback',
      model: req.model ?? 'fallback-model',
      provider: 'fallback',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 10,
    }));

    const composed = composeResilienceStack(primary, {
      breakers: new CircuitBreakerRegistry(DEFAULT_BREAKER),
      quota: new TenantQuotaRegistry(),
      fallbackProviders: [fallback],
    });

    const result = await composed.complete({
      taskType: 'classify_intent',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 'tenant-1',
      tenantTier: 'standard',
      model: 'gpt-4o-mini',
      deadlineMs: 5_000,
    });

    expect(result.content).toBe('ok-from-fallback');
    expect(result.providerPath?.some((p) => p.includes('primary'))).toBe(true);
    expect(result.providerPath?.some((p) => p.includes('fallback'))).toBe(true);
  });

  it('throws LLM_PROVIDER_UNAVAILABLE when primary and fallback both fail', async () => {
    const err5xx = Object.assign(new Error('boom'), { status: 503 });
    const primary = new ScriptedProvider('primary', async () => {
      throw err5xx;
    });
    const fallback = new ScriptedProvider('fallback', async () => {
      throw err5xx;
    });

    const composed = composeResilienceStack(primary, {
      breakers: new CircuitBreakerRegistry(DEFAULT_BREAKER),
      quota: new TenantQuotaRegistry(),
      fallbackProviders: [fallback],
    });

    const err = await composed
      .complete({
        taskType: 'classify_intent',
        messages: [{ role: 'user', content: 'hi' }],
        tenantId: 'tenant-1',
        model: 'gpt-4o-mini',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_PROVIDER_UNAVAILABLE');
  });
});

describe('FallbackModelMapProvider', () => {
  it('rewrites classify_intent model to fallback lightweight id', async () => {
    const inner = new ScriptedProvider('openrouter.ai', async (req) => ({
      content: 'ok',
      model: req.model ?? '',
      provider: 'openrouter.ai',
      tokenUsage: { input: 1, output: 1, total: 2 },
      latencyMs: 1,
    }));
    const wrapped = new FallbackModelMapProvider(inner, {
      lightweight: 'meta-llama/llama-3.1-8b-instruct',
      standard: 'meta-llama/llama-3.3-70b-instruct',
      complex: 'qwen/qwen2.5-vl-72b-instruct',
    });

    await wrapped.complete({
      taskType: 'classify_intent',
      messages: [{ role: 'user', content: 'x' }],
      tenantId: 't1',
      model: 'gpt-4o-mini',
    });

    expect(inner.calls[0].model).toBe('meta-llama/llama-3.1-8b-instruct');
  });
});
