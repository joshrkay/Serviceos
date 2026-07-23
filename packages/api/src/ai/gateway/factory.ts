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
import { createTenantQuotaStore, DEFAULT_TIER_CONFIG } from './tenant-quota';
import { composeResilienceStack, type ResilienceStackOptions } from './compose-resilience';
import {
  CachingGatewayWrapper,
  InMemoryCacheStore,
  type CacheConfig,
} from './cache';
import { createRedisCacheStore } from './redis-cache-store';
import { findProviderModelMismatch } from './provider-model-compat';
import { DEFAULT_AI_ROUTING_CONFIG } from '../../config/ai-routing';
import {
  FallbackModelMapProvider,
  resolveFallbackTierModelsFromEnv,
} from './fallback-model-map';

/**
 * Create the LLM gateway from application config.
 *
 * Switching providers is purely a .env change.
 *
 *   OpenAI primary (Profile A — production default):
 *     AI_PROVIDER_BASE_URL=https://api.openai.com/v1
 *     AI_PROVIDER_API_KEY=sk-...
 *     AI_DEFAULT_MODEL=gpt-4o-mini
 *
 *   Optional OpenRouter fallback (dual-provider — NOT a Profile B swap):
 *     AI_FALLBACK_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
 *     AI_FALLBACK_PROVIDER_API_KEY=sk-or-...
 *     AI_FALLBACK_LIGHTWEIGHT_MODEL=meta-llama/llama-3.1-8b-instruct
 *     See docs/runbooks/live-ai-restore.md ("Profile A + OpenRouter fallback")
 *
 *   OpenRouter-only primary (Profile B swap — different from failover):
 *     AI_PROVIDER_BASE_URL=https://openrouter.ai/api/v1
 *     AI_PROVIDER_API_KEY=sk-or-...
 *     See docs/runbooks/openrouter-ai-provider.md
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

/**
 * Module-level list of cache stores that need to be disconnected on shutdown.
 * Populated by maybeBuildCacheWrapper when a Redis store is wired.
 * Call shutdownCacheStores() in the SIGTERM handler to prevent connection leaks.
 */
const _cacheStoresToShutdown: Array<{ quit(): Promise<void> }> = [];

/**
 * Disconnect all active Redis cache store connections.
 * Call this from the app's SIGTERM/SIGINT shutdown handler before draining the DB pool.
 */
export async function shutdownCacheStores(): Promise<void> {
  await Promise.allSettled(_cacheStoresToShutdown.map((s) => s.quit()));
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

  // Static mismatch check (no network). Surfaces the 2026-07-20 failure mode
  // where Claude model ids were sent to api.openai.com while health stayed green.
  // Only check models that will actually be used for tenant traffic.
  const allPerTierSetForCheck =
    Boolean(process.env.AI_LIGHTWEIGHT_MODEL) &&
    Boolean(process.env.AI_STANDARD_MODEL) &&
    Boolean(process.env.AI_COMPLEX_MODEL);
  const modelsToCheck =
    config.AI_DEFAULT_MODEL && !allPerTierSetForCheck
      ? [config.AI_DEFAULT_MODEL]
      : [
          DEFAULT_AI_ROUTING_CONFIG.tiers.lightweight.model,
          DEFAULT_AI_ROUTING_CONFIG.tiers.standard.model,
          DEFAULT_AI_ROUTING_CONFIG.tiers.complex.model,
        ];
  const mismatch = findProviderModelMismatch(baseURL, modelsToCheck);
  if (mismatch) {
    const logger = opts.logger;
    logger?.error('AI provider/model mismatch — completions will fail until env is aligned', {
      providerHost: mismatch.providerHost,
      model: mismatch.model,
      modelFamily: mismatch.modelFamily,
      reason: mismatch.reason,
    });
    // Also stderr so Railway logs show it even without a structured logger.
    process.stderr.write(`[ERROR] ${mismatch.reason}\n`);
  }

  const primaryProvider = new OpenAICompatibleProvider({
    apiKey: config.AI_PROVIDER_API_KEY,
    baseURL,
    defaultHeaders:
      baseURL.includes('openrouter.ai')
        ? {
            'HTTP-Referer': 'https://rivet.ai',
            'X-Title': 'Rivet',
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
  // U3c — cluster-wide per-tenant quota when REDIS_URL is set (sync-return +
  // async Redis upgrade); per-replica in-memory registry otherwise. Identical
  // semantics; the seam is the same as the WS cap / gateway cache.
  const quotaRegistry =
    opts.resilience?.quota ?? createTenantQuotaStore(process.env.REDIS_URL, DEFAULT_TIER_CONFIG);

  // Publish the breaker registry for the health endpoint.
  sharedBreakerRegistry = breakerRegistry;

  // FM-03 — dual-provider failover. When both AI_FALLBACK_PROVIDER_* vars
  // are set, primary abort/5xx advances to OpenRouter (or any second host)
  // instead of sole-provider LLM_PROVIDER_UNAVAILABLE. Missing either var
  // keeps today's single-provider behavior (staged rollout safe).
  const fallbackProviders =
    opts.resilience?.fallbackProviders ??
    buildFallbackProvidersFromEnv(opts.logger);

  const resilientProvider = composeResilienceStack(shadowWrappedProvider, {
    ...opts.resilience,
    breakers: breakerRegistry,
    quota: quotaRegistry,
    fallbackProviders,
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

/**
 * Default cache-eligible task types for P2-031 — deterministic tasks whose
 * identical inputs yield identical outputs. Reconciled to the real gateway
 * taskTypes (follow-up #2): the live classifier emits `classify_intent`, not
 * `intent_classification`, so the old entry never matched a real call; and
 * `entity_extraction` / `transcript_normalization` matched no call site at all.
 */
const DEFAULT_DETERMINISTIC_TASK_TYPES: readonly string[] = [
  'classify_intent',
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
        _cacheStoresToShutdown.push(redisStore);
        opts.logger?.info('Redis cache store connected — upgraded from in-memory', {});
      } else {
        opts.logger?.info('Redis cache store unavailable — staying on in-memory store', {});
      }
    }).catch((err: unknown) => {
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
 * Build the LLMGatewayConfig, wiring AI_DEFAULT_MODEL as the global default
 * when per-tier env vars are not all explicitly set.
 *
 * Precedence:
 * 1. Per-tier env vars (AI_LIGHTWEIGHT_MODEL, AI_STANDARD_MODEL, AI_COMPLEX_MODEL)
 *    — take full precedence when all three are explicitly set (via
 *    DEFAULT_AI_ROUTING_CONFIG, which reads those env vars at module load).
 * 2. AI_DEFAULT_MODEL — stored under tenantOverrides[SYSTEM_TENANT_ID] and
 *    applied to EVERY tenant that has no explicit override (see
 *    LLMGateway.complete fallthrough). Without that fallthrough, only
 *    tenantId=system would see AI_DEFAULT_MODEL — the 2026-07-20 bug.
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
            lightweight: {
              ...DEFAULT_AI_ROUTING_CONFIG.tiers.lightweight,
              model: defaultModel!,
            },
            standard: {
              ...DEFAULT_AI_ROUTING_CONFIG.tiers.standard,
              model: defaultModel!,
            },
            complex: {
              ...DEFAULT_AI_ROUTING_CONFIG.tiers.complex,
              model: defaultModel!,
            },
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

/**
 * Build zero-or-one fallback providers from env. Exported for unit tests.
 * Requires BOTH key and base URL; partial config is ignored (no boot crash).
 */
export function buildFallbackProvidersFromEnv(
  logger?: LLMGatewayLogger,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider[] {
  const apiKey = env.AI_FALLBACK_PROVIDER_API_KEY?.trim();
  const baseURL = env.AI_FALLBACK_PROVIDER_BASE_URL?.trim();
  if (!apiKey || !baseURL) {
    if ((apiKey && !baseURL) || (!apiKey && baseURL)) {
      logger?.info(
        'AI_FALLBACK_PROVIDER_* partially set — ignoring fallback (need both API_KEY and BASE_URL)',
        {
          hasKey: Boolean(apiKey),
          hasBaseURL: Boolean(baseURL),
        },
      );
    }
    return [];
  }

  let parsedHost = 'fallback';
  try {
    parsedHost = new URL(baseURL).hostname;
  } catch {
    logger?.error('AI_FALLBACK_PROVIDER_BASE_URL is not a valid URL — ignoring fallback', {
      baseURL,
    });
    return [];
  }

  const raw = new OpenAICompatibleProvider({
    apiKey,
    baseURL,
    defaultHeaders: baseURL.includes('openrouter.ai')
      ? {
          'HTTP-Referer': 'https://rivet.ai',
          'X-Title': 'Rivet',
        }
      : undefined,
  });

  const tiers = resolveFallbackTierModelsFromEnv(env);
  logger?.info('AI fallback provider wired', {
    host: parsedHost,
    lightweightModel: tiers.lightweight,
    standardModel: tiers.standard,
    complexModel: tiers.complex,
  });

  return [new FallbackModelMapProvider(raw, tiers)];
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
 * Hermetic / local-demo gateway used when `AI_PROVIDER_API_KEY` is unset.
 * Scripts intent classification + free-text drafting so Assistant can create
 * real proposals without a paid provider key. Unit tests that need a fixed
 * JSON reply should keep using {@link createMockLLMGateway}.
 */
export function createHermeticMockLLMGateway(): {
  gateway: LLMGateway;
  provider: MockLLMProvider;
} {
  const provider = new MockLLMProvider('{"intentType":"unknown","confidence":0}', {
    hermetic: true,
  });
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
