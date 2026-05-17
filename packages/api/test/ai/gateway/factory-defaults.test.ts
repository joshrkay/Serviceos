/**
 * P2-028 review fix — AI_DEFAULT_MODEL env var wiring in createLLMGateway.
 *
 * Verifies that:
 * 1. When AI_DEFAULT_MODEL is set and per-tier env vars are NOT all set,
 *    the default model is applied to all three tiers via the system tenant override.
 * 2. When AI_DEFAULT_MODEL is set and all per-tier env vars ARE explicitly set,
 *    the per-tier env vars win (AI_DEFAULT_MODEL is effectively ignored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppConfig } from '../../../src/shared/config';
import type { LLMGatewayLogger } from '../../../src/ai/gateway/gateway';
import { SYSTEM_TENANT_ID } from '../../../src/ai/gateway/gateway';

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

interface LogEntry {
  message: string;
  meta?: Record<string, unknown>;
}

function makeCapturingLogger(): { logger: LLMGatewayLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: LLMGatewayLogger = {
    info: (message, meta) => entries.push({ message, meta }),
    error: (message, meta) => entries.push({ message, meta }),
  };
  return { logger, entries };
}

describe('createLLMGateway — AI_DEFAULT_MODEL wiring', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure per-tier env vars are absent unless set in the test
    delete process.env.AI_LIGHTWEIGHT_MODEL;
    delete process.env.AI_STANDARD_MODEL;
    delete process.env.AI_COMPLEX_MODEL;
    // Suppress shadow-comparison side-effects
    delete process.env.SHADOW_LLM_ENABLED;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    // Remove any keys that weren't in the original
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  it('applies AI_DEFAULT_MODEL to all tiers via system tenant override when no per-tier env vars set', async () => {
    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { logger, entries } = makeCapturingLogger();

    const gateway = createLLMGateway(cfg({ AI_DEFAULT_MODEL: 'gpt-4o-mini' }), { logger });

    // The gateway's internal config should have a system tenant override covering all tiers
    const internalConfig = (gateway as unknown as { config: { tenantOverrides?: Record<string, unknown> } }).config;
    const systemOverride = internalConfig.tenantOverrides?.[SYSTEM_TENANT_ID] as
      | { tiers: Record<string, { model: string }> }
      | undefined;

    expect(systemOverride).toBeDefined();
    expect(systemOverride?.tiers.lightweight.model).toBe('gpt-4o-mini');
    expect(systemOverride?.tiers.standard.model).toBe('gpt-4o-mini');
    expect(systemOverride?.tiers.complex.model).toBe('gpt-4o-mini');

    // Should emit an INFO log documenting what was wired
    const log = entries.find((e) => e.message.includes('AI_DEFAULT_MODEL'));
    expect(log).toBeDefined();
    expect(log?.message).toContain('gpt-4o-mini');
  });

  it('per-tier env vars win when all three are set, even if AI_DEFAULT_MODEL is also set', async () => {
    process.env.AI_LIGHTWEIGHT_MODEL = 'lightweight-override';
    process.env.AI_STANDARD_MODEL = 'standard-override';
    process.env.AI_COMPLEX_MODEL = 'complex-override';

    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { logger, entries } = makeCapturingLogger();

    const gateway = createLLMGateway(cfg({ AI_DEFAULT_MODEL: 'gpt-4o-mini' }), { logger });

    // No system tenant override should be set — per-tier env vars handle routing
    const internalConfig = (gateway as unknown as { config: { tenantOverrides?: Record<string, unknown> } }).config;
    const systemOverride = internalConfig.tenantOverrides?.[SYSTEM_TENANT_ID];
    expect(systemOverride).toBeUndefined();

    // Should emit an INFO log noting that AI_DEFAULT_MODEL is overridden
    const log = entries.find((e) => e.message.includes('overridden by per-tier'));
    expect(log).toBeDefined();
  });

  it('emits no special log and sets no system override when AI_DEFAULT_MODEL is not set', async () => {
    const { createLLMGateway } = await import('../../../src/ai/gateway/factory');
    const { logger, entries } = makeCapturingLogger();

    // Provide a config without AI_DEFAULT_MODEL (override with empty string to simulate unset)
    const configWithoutDefault = { ...cfg(), AI_DEFAULT_MODEL: undefined } as unknown as AppConfig;

    const gateway = createLLMGateway(configWithoutDefault, { logger });

    const internalConfig = (gateway as unknown as { config: { tenantOverrides?: Record<string, unknown> } }).config;
    const systemOverride = internalConfig.tenantOverrides?.[SYSTEM_TENANT_ID];
    expect(systemOverride).toBeUndefined();

    // Should not emit any AI_DEFAULT_MODEL log
    const log = entries.find((e) => e.message.includes('AI_DEFAULT_MODEL'));
    expect(log).toBeUndefined();
  });
});
