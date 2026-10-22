/**
 * GATEWAY-06 — the fallback hop honours each tier's own default model and is
 * capability-checked for images.
 *
 * Before: resolveFallbackTierModelsFromEnv cascaded standard AND complex to
 * the lightweight model (an 8B text-only Llama), so DEFAULT_FALLBACK_TIER_MODELS
 * .standard/.complex were dead, and FallbackModelMapProvider dispatched
 * image-bearing mms_estimate requests to whatever model the tier mapped to —
 * the gateway's vision fail-fast only ever checked the PRIMARY's model.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_FALLBACK_TIER_MODELS,
  FallbackModelMapProvider,
  FallbackModelNotVisionCapableError,
  resolveFallbackTierModelsFromEnv,
} from '../../../src/ai/gateway/fallback-model-map';
import { buildFallbackProvidersFromEnv } from '../../../src/ai/gateway/factory';
import { composeResilienceStack } from '../../../src/ai/gateway/compose-resilience';
import { CircuitBreakerRegistry, DEFAULT_BREAKER, isBreakerHealthFailure } from '../../../src/ai/gateway/breaker';
import { TenantQuotaRegistry } from '../../../src/ai/gateway/tenant-quota';
import { classifyError } from '../../../src/ai/gateway/retry';
import { isVisionCapableModel } from '../../../src/config/ai-routing';
import { AppError } from '../../../src/shared/errors';
import type { LLMProvider, LLMRequest, LLMResponse, LLMGatewayLogger } from '../../../src/ai/gateway/gateway';

function okInner(name = 'openrouter.ai') {
  const complete = vi.fn(async (req: LLMRequest): Promise<LLMResponse> => ({
    content: 'ok',
    model: req.model ?? '',
    provider: name,
    tokenUsage: { input: 1, output: 1, total: 2 },
    latencyMs: 1,
  }));
  const provider: LLMProvider = { name, complete, isAvailable: async () => true };
  return { provider, complete };
}

const photoQuote: LLMRequest = {
  taskType: 'mms_estimate',
  tenantId: 't1',
  model: 'gpt-4o',
  messages: [
    {
      role: 'user',
      content: 'Quote this',
      parts: [{ type: 'image', url: 'https://example.com/heater.jpg' }],
    },
  ],
};

describe('GATEWAY-06 — fallback tier defaults', () => {
  it('defaults each tier to its OWN fallback model, not the lightweight one', () => {
    const tiers = resolveFallbackTierModelsFromEnv({
      AI_FALLBACK_LIGHTWEIGHT_MODEL: 'meta-llama/llama-3.1-8b-instruct',
    });
    expect(tiers.lightweight).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(tiers.standard).toBe(DEFAULT_FALLBACK_TIER_MODELS.standard);
    expect(tiers.complex).toBe(DEFAULT_FALLBACK_TIER_MODELS.complex);
    // mms_estimate is complex-tier and carries photos.
    expect(isVisionCapableModel(tiers.complex)).toBe(true);
  });

  it('still honours explicit per-tier overrides', () => {
    expect(
      resolveFallbackTierModelsFromEnv({
        AI_FALLBACK_STANDARD_MODEL: 'a/standard',
        AI_FALLBACK_COMPLEX_MODEL: 'b/complex',
      }),
    ).toEqual({
      lightweight: DEFAULT_FALLBACK_TIER_MODELS.lightweight,
      standard: 'a/standard',
      complex: 'b/complex',
    });
  });
});

describe('GATEWAY-06 — FallbackModelMapProvider vision guard', () => {
  it('refuses an image request on a text-only fallback model without dispatching', async () => {
    const { provider, complete } = okInner();
    const wrapped = new FallbackModelMapProvider(provider, {
      ...DEFAULT_FALLBACK_TIER_MODELS,
      complex: 'meta-llama/llama-3.1-8b-instruct',
    });

    const err = await wrapped.complete(photoQuote).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FallbackModelNotVisionCapableError);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('LLM_FALLBACK_NOT_VISION_CAPABLE');
    expect(complete).not.toHaveBeenCalled();
    // A capability gap is not a health problem and not worth retrying.
    expect(isBreakerHealthFailure(err)).toBe(false);
    expect(classifyError(err)).toBe('permanent');
  });

  it('forwards an image request when the fallback model is vision-capable', async () => {
    const { provider, complete } = okInner();
    const wrapped = new FallbackModelMapProvider(provider, DEFAULT_FALLBACK_TIER_MODELS);
    await wrapped.complete(photoQuote);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].model).toBe(DEFAULT_FALLBACK_TIER_MODELS.complex);
  });

  it('end to end: primary 503 + text-only fallback surfaces the typed error with the trail', async () => {
    const primary: LLMProvider = {
      name: 'api.openai.com',
      complete: async () => {
        throw Object.assign(new Error('upstream 503'), { status: 503 });
      },
      isAvailable: async () => true,
    };
    const { provider: inner, complete } = okInner();
    const fallback = new FallbackModelMapProvider(inner, {
      ...DEFAULT_FALLBACK_TIER_MODELS,
      complex: 'meta-llama/llama-3.1-8b-instruct',
    });
    const stack = composeResilienceStack(primary, {
      breakers: new CircuitBreakerRegistry(DEFAULT_BREAKER),
      quota: new TenantQuotaRegistry(),
      fallbackProviders: [fallback],
    });

    const err = await stack.complete({ ...photoQuote, deadlineMs: 4_000 }).catch((e: unknown) => e);

    expect((err as AppError).code).toBe('LLM_FALLBACK_NOT_VISION_CAPABLE');
    expect((err as { providerPath?: string[] }).providerPath).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('GATEWAY-06 — boot warning', () => {
  function capture() {
    const entries: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: LLMGatewayLogger = {
      info: (message, meta) => entries.push({ message, meta }),
      error: (message, meta) => entries.push({ message, meta }),
    };
    return { logger, entries };
  }

  it('warns when the complex fallback model cannot take images', () => {
    const { logger, entries } = capture();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    buildFallbackProvidersFromEnv(logger, {
      AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
      AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_FALLBACK_COMPLEX_MODEL: 'meta-llama/llama-3.1-8b-instruct',
    });
    const warning = entries.find((e) => e.message.includes('not vision-capable'));
    expect(warning?.meta).toMatchObject({
      level: 'warn',
      complexModel: 'meta-llama/llama-3.1-8b-instruct',
    });
    vi.restoreAllMocks();
  });

  it('is quiet with the default (vision-capable) complex fallback', () => {
    const { logger, entries } = capture();
    buildFallbackProvidersFromEnv(logger, {
      AI_FALLBACK_PROVIDER_API_KEY: 'sk-or-test',
      AI_FALLBACK_PROVIDER_BASE_URL: 'https://openrouter.ai/api/v1',
    });
    expect(entries.find((e) => e.message.includes('not vision-capable'))).toBeUndefined();
  });
});
