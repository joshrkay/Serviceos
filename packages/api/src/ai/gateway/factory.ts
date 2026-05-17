import { LLMGateway, SYSTEM_TENANT_ID } from './gateway';
import type { LLMProvider, LLMGatewayConfig, LLMGatewayLogger } from './gateway';
import { OpenAICompatibleProvider } from '../providers/openai-compatible';
import type { EmbeddingProvider } from '../providers/openai-compatible';
import { MockLLMProvider } from '../providers/mock';
import {
  ShadowComparisonGateway,
  InMemoryShadowComparisonStore,
  ShadowComparisonStore,
} from '../evaluation/shadow-comparison';
import type { AppConfig } from '../../shared/config';
import type { AiRunRepository } from '../ai-run';

/**
 * Create the LLM gateway from application config.
 *
 * Switching providers is purely a .env change:
 *
 *   OpenAI:
 *     AI_PROVIDER_BASE_URL=https://api.openai.com/v1
 *     AI_PROVIDER_API_KEY=sk-...
 *     AI_DEFAULT_MODEL=gpt-4o-mini
 *
 *   OpenRouter:
 *     AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
 *     AI_PROVIDER_API_KEY=sk-or-...
 *     AI_DEFAULT_MODEL=openai/gpt-4o-mini
 *
 *   Any other OpenAI-compatible endpoint works the same way.
 */
export interface CreateLLMGatewayOptions {
  /**
   * Optional P2-030 shadow-comparison store. When supplied together with
   * shadow env vars (SHADOW_LLM_ENABLED=true + SHADOW_LLM_API_KEY etc.),
   * the primary provider is wrapped so a sampled percentage of requests
   * are replayed against the shadow model and persisted here.
   */
  shadowStore?: ShadowComparisonStore;
  logger?: LLMGatewayLogger;
  /**
   * Optional AI-run repository. When supplied, every gateway.complete() call
   * writes a row to ai_runs tracking the lifecycle: pending → running → completed/failed.
   * P2-027 Gap 1.
   */
  aiRunRepo?: AiRunRepository;
}

export function createLLMGateway(
  config: AppConfig,
  loggerOrOpts?: LLMGatewayLogger | CreateLLMGatewayOptions
): LLMGateway {
  if (!config.AI_PROVIDER_API_KEY) {
    throw new Error(
      'AI_PROVIDER_API_KEY is not set. Add it to .env to enable AI features.'
    );
  }

  const opts: CreateLLMGatewayOptions = !loggerOrOpts
    ? {}
    : 'shadowStore' in (loggerOrOpts as CreateLLMGatewayOptions) ||
        'logger' in (loggerOrOpts as CreateLLMGatewayOptions) ||
        'aiRunRepo' in (loggerOrOpts as CreateLLMGatewayOptions)
      ? (loggerOrOpts as CreateLLMGatewayOptions)
      : { logger: loggerOrOpts as LLMGatewayLogger };

  const baseURL = config.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1';

  const primaryProvider = new OpenAICompatibleProvider({
    apiKey: config.AI_PROVIDER_API_KEY,
    baseURL,
    defaultHeaders:
      baseURL.includes('openrouter.ai')
        ? {
            'HTTP-Referer': 'https://serviceos.app',
            'X-Title': 'ServiceOS',
          }
        : undefined,
  });

  // P2-030 — optional shadow-comparison wrapper. Opt in by setting
  // SHADOW_LLM_ENABLED=true + SHADOW_LLM_API_KEY (+ optional
  // SHADOW_LLM_BASE_URL, SHADOW_LLM_MODEL, SHADOW_LLM_SAMPLING_RATE).
  // When disabled, the primary provider is used as-is — zero overhead.
  const provider: LLMProvider = maybeWrapWithShadow(primaryProvider, opts.shadowStore);

  const providers = new Map<string, LLMProvider>([[provider.name, provider]]);
  const gatewayConfig: LLMGatewayConfig = buildGatewayConfig(
    provider.name,
    config.AI_DEFAULT_MODEL,
    opts.logger,
  );
  return new LLMGateway(gatewayConfig, providers, opts.logger, opts.aiRunRepo);
}

/**
 * Build the LLMGatewayConfig, wiring AI_DEFAULT_MODEL as a system-tenant
 * fallback when per-tier env vars are not all explicitly set.
 *
 * Precedence:
 * 1. Per-tier env vars (AI_LIGHTWEIGHT_MODEL, AI_STANDARD_MODEL, AI_COMPLEX_MODEL)
 *    — take full precedence when all three are explicitly set.
 * 2. AI_DEFAULT_MODEL — applies to all tiers via tenantOverrides[SYSTEM_TENANT_ID]
 *    when set and NOT all per-tier env vars are provided.
 * 3. Built-in defaults in DEFAULT_AI_ROUTING_CONFIG.
 *
 * A one-time INFO log is emitted at construction time describing what was wired.
 */
function buildGatewayConfig(
  providerName: string,
  defaultModel: string | undefined,
  logger?: LLMGatewayLogger,
): LLMGatewayConfig {
  const hasDefaultModel = Boolean(defaultModel);
  const hasLightweight = Boolean(process.env.AI_LIGHTWEIGHT_MODEL);
  const hasStandard = Boolean(process.env.AI_STANDARD_MODEL);
  const hasComplex = Boolean(process.env.AI_COMPLEX_MODEL);
  const allPerTierSet = hasLightweight && hasStandard && hasComplex;

  if (hasDefaultModel && !allPerTierSet) {
    // Operator set AI_DEFAULT_MODEL without specifying all per-tier models.
    // Preserve backward-compatible behaviour: use the default model for all tiers.
    logger?.info(`Using AI_DEFAULT_MODEL=${defaultModel} for all tiers`, {
      AI_DEFAULT_MODEL: defaultModel,
      hasLightweight,
      hasStandard,
      hasComplex,
    });
    return {
      defaultProvider: providerName,
      tenantOverrides: {
        [SYSTEM_TENANT_ID]: {
          tiers: {
            lightweight: { model: defaultModel!, provider: providerName },
            standard: { model: defaultModel!, provider: providerName },
            complex: { model: defaultModel!, provider: providerName },
          },
        },
      },
    };
  }

  if (hasDefaultModel && allPerTierSet) {
    // Per-tier env vars win; AI_DEFAULT_MODEL is effectively ignored.
    logger?.info(
      `AI_DEFAULT_MODEL is set but overridden by per-tier env vars (AI_LIGHTWEIGHT_MODEL, AI_STANDARD_MODEL, AI_COMPLEX_MODEL)`,
      {
        AI_DEFAULT_MODEL: defaultModel,
        AI_LIGHTWEIGHT_MODEL: process.env.AI_LIGHTWEIGHT_MODEL,
        AI_STANDARD_MODEL: process.env.AI_STANDARD_MODEL,
        AI_COMPLEX_MODEL: process.env.AI_COMPLEX_MODEL,
      },
    );
  }

  return { defaultProvider: providerName };
}

function maybeWrapWithShadow(
  primary: LLMProvider,
  explicitStore?: ShadowComparisonStore
): LLMProvider {
  if (process.env.SHADOW_LLM_ENABLED !== 'true') return primary;

  const shadowKey = process.env.SHADOW_LLM_API_KEY;
  if (!shadowKey) return primary;

  const shadowBaseURL =
    process.env.SHADOW_LLM_BASE_URL ?? 'https://api.openai.com/v1';
  const samplingRate = Number(process.env.SHADOW_LLM_SAMPLING_RATE ?? '0.1');

  const shadow = new OpenAICompatibleProvider({
    apiKey: shadowKey,
    baseURL: shadowBaseURL,
  });

  return new ShadowComparisonGateway(
    primary,
    shadow,
    explicitStore ?? new InMemoryShadowComparisonStore(),
    {
      enabled: true,
      samplingRate: Number.isFinite(samplingRate) ? samplingRate : 0.1,
      shadowProvider: shadow.name,
    }
  );
}

/** Create a mock gateway for tests — no API key needed */
export function createMockLLMGateway(defaultResponse = '{"mock": true}'): {
  gateway: LLMGateway;
  provider: MockLLMProvider;
} {
  const provider = new MockLLMProvider(defaultResponse);
  const providers = new Map<string, LLMProvider>([['mock', provider]]);
  const gatewayConfig: LLMGatewayConfig = { defaultProvider: 'mock' };
  const gateway = new LLMGateway(gatewayConfig, providers);
  return { gateway, provider };
}

/**
 * Phase 4a-1 — dedicated `EmbeddingProvider` for the RAG corpus.
 *
 * Returns `null` when `AI_PROVIDER_API_KEY` is unset so the rest of the
 * app boots without embeddings (the ingestion workers stay
 * un-registered in that case). The chat-completions gateway routes
 * through shadow/router logic that does not apply to embeddings
 * (`text-embedding-3-small` only), which is why this is a separate
 * factory rather than a method on `LLMGateway`.
 *
 * Centralising construction here is what keeps the
 * "all AI calls route through ai/gateway" invariant true — callers
 * outside this directory must never `new OpenAICompatibleProvider(...)`.
 */
export function createEmbeddingProvider(
  config: AppConfig
): EmbeddingProvider | null {
  if (!config.AI_PROVIDER_API_KEY) return null;
  return new OpenAICompatibleProvider({
    apiKey: config.AI_PROVIDER_API_KEY,
    baseURL: config.AI_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1',
  });
}
