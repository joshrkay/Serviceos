/**
 * P2-031 — factory cache wiring tests
 *
 * Verifies that createLLMGateway() correctly wraps or skips the cache layer
 * based on AI_CACHE_ENABLED and REDIS_URL environment variables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppConfig } from '../../../src/shared/config';

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

    expect(taskTypes).toContain('intent_classification');
    expect(taskTypes).toContain('entity_extraction');
    expect(taskTypes).toContain('transcript_normalization');
    expect(taskTypes).toContain('extract_categories');

    // Non-deterministic types must NOT be in the list
    expect(taskTypes).not.toContain('draft_estimate');
    expect(taskTypes).not.toContain('generate_proposal');
  });
});
