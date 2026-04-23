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

  it('does not wrap the primary provider when SHADOW_LLM_ENABLED is unset', () => {
    const gateway = createLLMGateway(cfg());
    // @ts-expect-error reach into internals for structural verification
    const providers = gateway.providers as Map<string, { constructor: { name: string } }>;
    const [p] = providers.values();
    expect(p.constructor.name).not.toBe('ShadowComparisonGateway');
    expect(p.constructor.name).toBe('OpenAICompatibleProvider');
  });

  it('wraps with ShadowComparisonGateway when SHADOW_LLM_ENABLED=true and key present', () => {
    process.env.SHADOW_LLM_ENABLED = 'true';
    process.env.SHADOW_LLM_API_KEY = 'sk-shadow';

    const store = new InMemoryShadowComparisonStore();
    const gateway = createLLMGateway(cfg(), { shadowStore: store });

    // @ts-expect-error reach into internals for structural verification
    const providers = gateway.providers as Map<string, { constructor: { name: string } }>;
    const [p] = providers.values();
    expect(p.constructor.name).toBe('ShadowComparisonGateway');
  });

  it('skips wrapping when SHADOW_LLM_ENABLED=true but API key is missing', () => {
    process.env.SHADOW_LLM_ENABLED = 'true';
    // no SHADOW_LLM_API_KEY

    const gateway = createLLMGateway(cfg());
    // @ts-expect-error reach into internals
    const providers = gateway.providers as Map<string, { constructor: { name: string } }>;
    const [p] = providers.values();
    expect(p.constructor.name).toBe('OpenAICompatibleProvider');
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
