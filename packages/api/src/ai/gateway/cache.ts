import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { LLMRequest, LLMResponse, LLMGateway } from './gateway';
import type { AiRunRepository } from '../ai-run';
import { createAiRun } from '../ai-run';
import {
  gatewayCacheHitsTotal,
  gatewayCacheMissesTotal,
} from '../../monitoring/metrics';

export interface CacheEntry {
  response: LLMResponse;
  cachedAt: number;
  ttlMs: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional — disconnect the underlying store connection (e.g. Redis). */
  quit?(): Promise<void>;
}

export interface CacheConfig {
  enabled: boolean;
  defaultTtlMs: number;
  taskTtlMs?: Record<string, number>;
  deterministicTaskTypes: string[];
}

export function createCacheKey(request: LLMRequest, tenantId: string): string {
  const keyData = {
    model: request.model,
    messages: request.messages,
    taskType: request.taskType,
    tenantId,
  };
  return createHash('sha256').update(JSON.stringify(keyData)).digest('hex');
}

export class InMemoryCacheStore implements CacheStore {
  private store: Map<string, CacheEntry> = new Map();

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return entry;
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    if (entry.ttlMs <= 0) {
      // No-op: zero/negative TTL would expire immediately — consistent with RedisCacheStore.
      return;
    }
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class CachingGatewayWrapper {
  readonly config: CacheConfig;
  /** Exposed so the factory can asynchronously swap InMemory → Redis post-construction. */
  cacheStore: CacheStore;
  private readonly gateway: LLMGateway;
  private readonly tenantId: string;
  private readonly aiRunRepo?: AiRunRepository;
  private hits = 0;
  private misses = 0;

  constructor(
    gateway: LLMGateway,
    cacheStore: CacheStore,
    config: CacheConfig,
    tenantId: string,
    aiRunRepo?: AiRunRepository,
  ) {
    this.gateway = gateway;
    this.cacheStore = cacheStore;
    this.config = config;
    this.tenantId = tenantId;
    this.aiRunRepo = aiRunRepo;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const isDeterministic = this.config.enabled &&
      this.config.deterministicTaskTypes.includes(request.taskType);

    if (!isDeterministic) {
      // Non-deterministic tasks bypass the cache entirely and must NOT
      // contribute to the miss counter (help text: "deterministic tasks not found in cache").
      return this.gateway.complete(request);
    }

    // Use || so an empty-string tenantId also falls back to the wrapper's tenantId.
    const effectiveTenantId = request.tenantId || this.tenantId;
    const cacheKey = createCacheKey(request, effectiveTenantId);
    const cached = await this.cacheStore.get(cacheKey);

    if (cached) {
      const now = Date.now();
      const isExpired = now - cached.cachedAt >= cached.ttlMs;

      if (!isExpired) {
        this.hits++;
        gatewayCacheHitsTotal.inc({ taskType: request.taskType });

        // Write AiRun row for cache hit so audit is never blind (best-effort).
        // Fire-and-forget: the function has internal try/catch so a void call is safe.
        void this.writeAiRunForCacheHit(request, cached.response);

        return { ...cached.response, cached: true };
      }
    }

    this.misses++;
    gatewayCacheMissesTotal.inc({ taskType: request.taskType });

    const response = await this.gateway.complete(request);

    const ttlMs = this.config.taskTtlMs?.[request.taskType] ?? this.config.defaultTtlMs;

    await this.cacheStore.set(cacheKey, {
      response,
      cachedAt: Date.now(),
      ttlMs,
    });

    return response;
  }

  getStats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * Write a completed AiRun row for a cache hit.
   * This ensures the audit trail is never blind even when the LLM is not called.
   * Best-effort: failures are swallowed so cache hits are never blocked.
   */
  private async writeAiRunForCacheHit(
    request: LLMRequest,
    cachedResponse: LLMResponse,
  ): Promise<void> {
    if (!this.aiRunRepo) return;

    try {
      const tenantId = request.tenantId ?? this.tenantId;
      const correlationId =
        (request.metadata?.correlationId as string | undefined) ?? uuidv4();
      const promptVersionId = request.metadata?.promptVersionId as string | undefined;
      const now = new Date();

      const pendingRun = createAiRun({
        tenantId,
        taskType: request.taskType,
        model: cachedResponse.model,
        promptVersionId,
        inputSnapshot: {
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.maxTokens,
        },
        createdBy: 'gateway-cache',
        correlationId,
      });

      const runWithTiming = {
        ...pendingRun,
        startedAt: now,
      };

      const aiRun = await this.aiRunRepo.create(runWithTiming);

      await this.aiRunRepo.updateStatus(tenantId, aiRun.id, 'completed', {
        outputSnapshot: {
          content: cachedResponse.content,
          provider: cachedResponse.provider,
          cached: true,
        },
        tokenUsage: cachedResponse.tokenUsage,
        completedAt: new Date(),
        durationMs: 0,
      });
    } catch {
      // Best-effort — audit failure must not block the cached response
    }
  }
}
