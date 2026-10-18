/**
 * GATEWAY-04 — the gateway factory warns at boot when a configured model has
 * no price, so `costMicroCents: null` on every call is never silent.
 *
 * OpenAI models are deliberately unpriced by default (model-pricing.ts:
 * "never a guess"), which means the default production deploy (Profile A,
 * gpt-4o-mini / gpt-4o) records null spend on every ai_runs row until ops set
 * AI_MODEL_PRICING_JSON. That policy stays; the silence does not.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AppConfig } from '../../../src/shared/config';
import type { LLMGatewayLogger } from '../../../src/ai/gateway/gateway';

const cfg = {
  NODE_ENV: 'test',
  AI_PROVIDER_API_KEY: 'sk-test',
  AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
  AI_DEFAULT_MODEL: 'gpt-4o-mini',
} as unknown as AppConfig;

function capturingLogger() {
  const entries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const logger: LLMGatewayLogger = {
    info: (message, meta) => entries.push({ message, meta }),
    error: (message, meta) => entries.push({ message, meta }),
  };
  return { logger, entries };
}

async function freshFactory() {
  vi.resetModules();
  return import('../../../src/ai/gateway/factory');
}

describe('GATEWAY-04 — boot warning for unpriced models', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function clearModelEnv() {
    delete process.env.AI_MODEL_PRICING_JSON;
    delete process.env.AI_LIGHTWEIGHT_MODEL;
    delete process.env.AI_STANDARD_MODEL;
    delete process.env.AI_COMPLEX_MODEL;
    delete process.env.AI_FALLBACK_PROVIDER_API_KEY;
    delete process.env.AI_FALLBACK_PROVIDER_BASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.AI_QUOTA_TIERS_JSON;
  }

  it('warns, naming the model, when the configured primary model has no price', async () => {
    clearModelEnv();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { createLLMGateway } = await freshFactory();
    const { logger, entries } = capturingLogger();

    createLLMGateway(cfg, { logger });

    const warning = entries.find((e) => e.message.includes('no price'));
    expect(warning?.meta).toMatchObject({ level: 'warn', models: ['gpt-4o-mini'] });
    expect(stderr.mock.calls.some(([line]) => String(line).includes('gpt-4o-mini'))).toBe(true);
  });

  it('stays quiet once AI_MODEL_PRICING_JSON prices it', async () => {
    clearModelEnv();
    process.env.AI_MODEL_PRICING_JSON = JSON.stringify({
      'gpt-4o-mini': { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 },
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { createLLMGateway } = await freshFactory();
    const { logger, entries } = capturingLogger();

    createLLMGateway(cfg, { logger });

    expect(entries.find((e) => e.message.includes('no price'))).toBeUndefined();
  });

  it('also checks the fallback tier models', async () => {
    clearModelEnv();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { buildFallbackProvidersFromEnv } = await freshFactory();
    const { logger, entries } = capturingLogger();

    buildFallbackProvidersFromEnv(logger, {
      AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
      AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_FALLBACK_LIGHTWEIGHT_MODEL: 'mistralai/some-unpriced-model',
    });

    const warning = entries.find((e) => e.message.includes('no price'));
    expect(warning?.meta?.models).toContain('mistralai/some-unpriced-model');
  });
});
