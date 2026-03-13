import { createHash } from 'crypto';
import { LLMRequest, LLMResponse, LLMGateway, LLMGatewayConfig, LLMProvider } from './gateway';

export interface CacheEntry {
  response: LLMResponse;
  cachedAt: number;
  ttlMs: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
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
    this.store.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class CachingGatewayWrapper {
  private readonly gateway: LLMGateway;
  private readonly cacheStore: CacheStore;
  private readonly config: CacheConfig;
  private readonly tenantId: string;
  private hits = 0;
  private misses = 0;

  constructor(gateway: LLMGateway, cacheStore: CacheStore, config: CacheConfig, tenantId: string) {
    this.gateway = gateway;
    this.cacheStore = cacheStore;
    this.config = config;
    this.tenantId = tenantId;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const isDeterministic = this.config.enabled &&
      this.config.deterministicTaskTypes.includes(request.taskType);

    if (!isDeterministic) {
      this.misses++;
      return this.gateway.complete(request);
    }

    const cacheKey = createCacheKey(request, this.tenantId);
    const cached = await this.cacheStore.get(cacheKey);

    if (cached) {
      const now = Date.now();
      const isExpired = now - cached.cachedAt >= cached.ttlMs;

      if (!isExpired) {
        this.hits++;
        return { ...cached.response, cached: true };
      }
    }

    this.misses++;

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
}
