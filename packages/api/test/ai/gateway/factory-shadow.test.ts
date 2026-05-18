/**
 * P2-030 — shadow-comparison wiring into the gateway factory.
 *
 * Verifies that createLLMGateway opts into ShadowComparisonGateway when the
 * SHADOW_LLM_* env vars are set, and that it stays zero-overhead otherwise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLLMGateway } from '../../../src/ai/gateway/factory';
import { InMemoryShadowComparisonStore } from '../../../src/ai/evaluation/shadow-comparison';
import type { AppConfig } from '../../../src/shared/config';

function cfg(): AppConfig {
  return {
    NODE_ENV: 'test',
    PORT: 3000,
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    AI_PROVIDER_API_KEY: 'sk-primary',
    AI_DEFAULT_MODEL: 'gpt-4o-mini',
    LOG_LEVEL: 'info',
    R2_BUCKET: 'serviceos-uploads',
  } as unknown as AppConfig;
}

describe('createLLMGateway — shadow-comparison wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SHADOW_LLM_ENABLED;
    delete process.env.SHADOW_LLM_API_KEY;
    delete process.env.SHADOW_LLM_BASE_URL;
    delete process.env.SHADOW_LLM_SAMPLING_RATE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /**
   * After P2-029 the gateway stores:
   *   ProviderTenantQuotaWrapper
   *     .inner: ProviderFailoverWrapper
   *       .providers[0]: ProviderBreakerWrapper
   *         .inner: ProviderRetryDeadlineWrapper
   *           .inner: <shadow-wrapped or raw provider>
   */
  function getInnermostProvider(p: unknown): unknown {
    // TenantQuota → Failover → Breaker → RetryDeadline → raw
    const tqw = p as { inner?: unknown };
    const fow = tqw.inner as { providers?: unknown[] } | undefined;
    const bw = (fow?.providers?.[0] ?? null) as { inner?: unknown } | null;
    const rdw = bw?.inner as { inner?: unknown } | null;
    return rdw?.inner ?? bw?.inner ?? fow ?? tqw.inner ?? p;
  }

  it('does not wrap the primary provider when SHADOW_LLM_ENABLED is unset', () => {
    const gateway = createLLMGateway(cfg());
    // @ts-expect-error reach into internals for structural verification
    const providers = gateway.providers as Map<string, unknown>;
    const [outermost] = providers.values();
    // P2-029: outermost provider is now ProviderTenantQuotaWrapper (resilience stack)
    expect((outermost as { constructor: { name: string } }).constructor.name).toBe('ProviderTenantQuotaWrapper');
    // The innermost provider should be the raw OpenAICompatibleProvider (not ShadowComparisonGateway)
    const innermost = getInnermostProvider(outermost);
    expect((innermost as { constructor: { name: string } }).constructor.name).toBe('OpenAICompatibleProvider');
  });

  it('wraps with ShadowComparisonGateway when SHADOW_LLM_ENABLED=true and key present', () => {
    process.env.SHADOW_LLM_ENABLED = 'true';
    process.env.SHADOW_LLM_API_KEY = 'sk-shadow';

    const store = new InMemoryShadowComparisonStore();
    const gateway = createLLMGateway(cfg(), { shadowStore: store });

    // @ts-expect-error reach into internals for structural verification
    const providers = gateway.providers as Map<string, unknown>;
    const [outermost] = providers.values();
    // The innermost provider should be a ShadowComparisonGateway (shadow is innermost)
    const innermost = getInnermostProvider(outermost);
    expect((innermost as { constructor: { name: string } }).constructor.name).toBe('ShadowComparisonGateway');
  });

  it('skips wrapping when SHADOW_LLM_ENABLED=true but API key is missing', () => {
    process.env.SHADOW_LLM_ENABLED = 'true';
    // no SHADOW_LLM_API_KEY

    const gateway = createLLMGateway(cfg());
    // @ts-expect-error reach into internals
    const providers = gateway.providers as Map<string, unknown>;
    const [outermost] = providers.values();
    // Without shadow API key the innermost should be OpenAICompatibleProvider
    const innermost = getInnermostProvider(outermost);
    expect((innermost as { constructor: { name: string } }).constructor.name).toBe('OpenAICompatibleProvider');
  });

  it('accepts legacy logger-only arg without breaking existing callers', () => {
    const logger = {
      error: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
    };
    expect(() => createLLMGateway(cfg(), logger)).not.toThrow();
  });
});
