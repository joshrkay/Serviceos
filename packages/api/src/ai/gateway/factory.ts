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
import { CircuitBreakerRegistry, DEFAULT_BREAKER } from './breaker';
import { TenantQuotaRegistry, DEFAULT_TIER_CONFIG } from './tenant-quota';
import { composeResilienceStack, type ResilienceStackOptions } from './compose-resilience';
import {
  CachingGatewayWrapper,
  InMemoryCacheStore,
  type CacheConfig,
} from './cache';
import { createRedisCacheStore } from './redis-cache-store';

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
  /**
   * P2-029 resilience stack overrides.
   * When not supplied the defaults in composeResilienceStack() are used.
   */
  resilience?: ResilienceStackOptions;
}

/**
 * Shared circuit breaker registry created by createLLMGateway().
 * Exposed so the AI health endpoint can read per-cell state without
 * coupling app.ts to gateway internals.
 *
 * Set to the live registry when createLLMGateway() is called. Starts
 * undefined so the health endpoint can gracefully handle the case where
 * the gateway has not yet been created.
 */
export let sharedBreakerRegistry: CircuitBreakerRegistry | undefined;

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
  // Shadow wrapping is the innermost layer — it wraps the raw provider
  // before the resilience stack so shadow calls are transparent to breakers/retry.
  const shadowWrappedProvider: LLMProvider = maybeWrapWithShadow(primaryProvider, opts.shadowStore);

  // P2-029 — resilience stack composition.
  // Order (innermost → outermost):
  //   shadow(primary) → retry+deadline+breaker (per provider) → failover → tenant-quota
  // The breaker registry is shared and exported for the /api/health/ai endpoint.
  const breakerRegistry = opts.resilience?.breakers ??
    new CircuitBreakerRegistry(opts.resilience?.breakerConfig ?? DEFAULT_BREAKER);
  const quotaRegistry = opts.resilience?.quota ?? new TenantQuotaRegistry(DEFAULT_TIER_CONFIG);

  // Publish the breaker registry for the health endpoint.
  sharedBreakerRegistry = breakerRegistry;

  const resilientProvider = composeResilienceStack(shadowWrappedProvider, {
    ...opts.resilience,
    breakers: breakerRegistry,
    quota: quotaRegistry,
  });

  const providers = new Map<string, LLMProvider>([[resilientProvider.name, resilientProvider]]);
  const gatewayConfig: LLMGatewayConfig = buildGatewayConfig(
    resilientProvider.name,
    config.AI_DEFAULT_MODEL,
    opts.logger,
  );
  const bareGateway = new LLMGateway(gatewayConfig, providers, opts.logger, opts.aiRunRepo);

  // P2-031 — optional response cache. Opt in with AI_CACHE_ENABLED=true.
  // Cache sits OUTSIDE the resilience stack so a hit never burns breaker budget.
  // When disabled (default), zero overhead — no wrapper is created.
  if (process.env.AI_CACHE_ENABLED !== 'true') {
    return bareGateway;
  }

  return maybeBuildCacheWrapper(bareGateway, opts);
}

/** Default cache-eligible task types for P2-031. */
const DEFAULT_DETERMINISTIC_TASK_TYPES: readonly string[] = [
  'intent_classification',
  'entity_extraction',
  'transcript_normalization',
  'extract_categories',
];

/**
 * Build a CachingGatewayWrapper around the assembled gateway.
 * When REDIS_URL is set, uses RedisCacheStore; otherwise falls back to InMemoryCacheStore.
 * This function intentionally returns synchronously using InMemory by default,
 * and upgrades to Redis in the background. The sync return path means the factory
 * remains synchronous for the common case.
 *
 * NOTE: When REDIS_URL is set, the Redis connection attempt is made synchronously
 * via createRedisCacheStore. If Redis is unavailable, we fall back to InMemory.
 */
function maybeBuildCacheWrapper(
  gateway: LLMGateway,
  opts: CreateLLMGatewayOptions,
): LLMGateway {
  const cacheConfig: CacheConfig = {
    enabled: true,
    defaultTtlMs: 3_600_000, // 1 hour default
    deterministicTaskTypes: [...DEFAULT_DETERMINISTIC_TASK_TYPES],
  };

  // For Redis: we use a synchronous wrapper that initialises the store lazily.
  // If REDIS_URL is set, we construct with a placeholder InMemory store,
  // then swap it out asynchronously. The simpler approach: use InMemory if Redis
  // URL is set but unavailable, and document that Redis is best-effort.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    // Build with InMemory fallback first (synchronous), then asynchronously
    // upgrade to Redis. This keeps the factory synchronous — callers don't
    // need to await. Cache failures are silent (best-effort).
    const inMemoryFallback = new InMemoryCacheStore();
    const wrapper = new CachingGatewayWrapper(
      gateway,
      inMemoryFallback,
      cacheConfig,
      'system',
      opts.aiRunRepo,
    );

    createRedisCacheStore(redisUrl).then((redisStore) => {
      if (redisStore) {
        wrapper.cacheStore = redisStore;
      }
    }).catch((err: unknown) => {
      // TODO(P2-031): LLMGatewayLogger lacks a .warn() method. Once the logger
      // interface is extended with warn(), replace this with:
      //   opts.logger?.warn('Redis cache store failed to connect; staying on in-memory store', { error: ... })
      // For now, surface the failure via .error() so operators can see it in logs.
      opts.logger?.error('Redis cache store failed to connect; staying on in-memory store', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return wrapper as unknown as LLMGateway;
  }

  return new CachingGatewayWrapper(
    gateway,
    new InMemoryCacheStore(),
    cacheConfig,
    'system',
    opts.aiRunRepo,
  ) as unknown as LLMGateway;
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
