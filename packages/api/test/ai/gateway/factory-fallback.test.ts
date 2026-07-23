/**
 * FM-03 — dual-provider failover wiring from AI_FALLBACK_PROVIDER_* env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createLLMGateway,
  buildFallbackProviders,
  FallbackModelOverrideProvider,
  DEFAULT_FALLBACK_LIGHTWEIGHT_MODEL,
} from '../../../src/ai/gateway/factory';
import type { AppConfig } from '../../../src/shared/config';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/gateway/gateway';

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
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
    ...overrides,
  } as unknown as AppConfig;
}

function failoverProviders(gateway: ReturnType<typeof createLLMGateway>): unknown[] {
  // @ts-expect-error reach into internals for structural verification
  const providers = gateway.providers as Map<string, unknown>;
  const [outermost] = providers.values();
  // TenantQuota → Failover
  const tqw = outermost as { inner?: { providers?: unknown[] } };
  return tqw.inner?.providers ?? [];
}

describe('buildFallbackProviders / createLLMGateway failover wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AI_FALLBACK_PROVIDER_API_KEY;
    delete process.env.AI_FALLBACK_PROVIDER_BASE_URL;
    delete process.env.AI_FALLBACK_LIGHTWEIGHT_MODEL;
    delete process.env.SHADOW_LLM_ENABLED;
    delete process.env.AI_CACHE_ENABLED;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns empty list when only one fallback env var is set', () => {
    expect(
      buildFallbackProviders(
        cfg({ AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test' } as Partial<AppConfig>),
      ),
    ).toEqual([]);
    process.env.AI_FALLBACK_PROVIDER_BASE_URL = 'https://openrouter.ai/api/v1';
    expect(buildFallbackProviders(cfg())).toEqual([]);
  });

  it('builds one OpenRouter-backed fallback when both env vars are set', () => {
    const providers = buildFallbackProviders(
      cfg({
        AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
        AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      } as Partial<AppConfig>),
    );
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(FallbackModelOverrideProvider);
    expect(providers[0].name).toBe('openrouter.ai');
  });

  it('wires fallbackProviders into the failover wrapper when both vars set', () => {
    const gateway = createLLMGateway(
      cfg({
        AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
        AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      } as Partial<AppConfig>),
    );
    const cells = failoverProviders(gateway);
    expect(cells).toHaveLength(2);
    expect((cells[0] as { name: string }).name).toBe('api.openai.com');
    expect((cells[1] as { name: string }).name).toBe('openrouter.ai');
  });

  it('keeps single-provider failover list when fallback env unset', () => {
    const gateway = createLLMGateway(cfg());
    expect(failoverProviders(gateway)).toHaveLength(1);
  });

  it('FallbackModelOverrideProvider rewrites classify_intent model', async () => {
    let seenModel: string | undefined;
    const inner: LLMProvider = {
      name: 'openrouter.ai',
      async complete(req: LLMRequest): Promise<LLMResponse> {
        seenModel = req.model;
        return {
          content: '{}',
          model: req.model ?? 'x',
          provider: 'openrouter.ai',
          tokenUsage: { input: 1, output: 1, total: 2 },
          latencyMs: 1,
        };
      },
      async isAvailable() {
        return true;
      },
    };
    const wrapped = new FallbackModelOverrideProvider(inner, DEFAULT_FALLBACK_LIGHTWEIGHT_MODEL);
    await wrapped.complete({
      taskType: 'classify_intent',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 't1',
    });
    expect(seenModel).toBe(DEFAULT_FALLBACK_LIGHTWEIGHT_MODEL);

    await wrapped.complete({
      taskType: 'draft_estimate',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tenantId: 't1',
    });
    expect(seenModel).toBe('gpt-4o');
  });
});
