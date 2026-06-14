import { v4 as uuidv4 } from 'uuid';
import { LLMRequest, LLMResponse, LLMProvider, messagesContainImage } from '../gateway/gateway';

export interface ShadowComparisonResult {
  id: string;
  comparisonGroupId: string;
  taskType: string;
  primaryResponse: LLMResponse;
  shadowResponse?: LLMResponse;
  shadowError?: string;
  /** P2-030: divergence score computed by P2-020; nullable until scored. */
  divergenceScore?: number | null;
  sampledAt: Date;
  /** P2-030: tenant owning this comparison (required for durable Pg storage). */
  tenantId?: string;
  /** P2-030: ai_run_id of the primary call that triggered this comparison. */
  aiRunId?: string;
}

export interface ShadowComparisonConfig {
  enabled: boolean;
  samplingRate: number; // 0-1, default 0.1
  shadowProvider: string;
  sampleFn?: () => number;
}

export interface ShadowComparisonListOptions {
  taskType?: string;
  limit?: number;
  cursor?: string;
}

export interface ShadowComparisonPage {
  comparisons: ShadowComparisonResult[];
  nextCursor: string | null;
}

export interface ShadowComparisonStore {
  save(result: ShadowComparisonResult): Promise<ShadowComparisonResult>;
  findByGroup(groupId: string): Promise<ShadowComparisonResult[]>;
  getAll(): Promise<ShadowComparisonResult[]>;
  /** P2-030: paginated tenant-scoped read for the admin API. */
  listForTenant(tenantId: string, opts?: ShadowComparisonListOptions): Promise<ShadowComparisonPage>;
}

export class InMemoryShadowComparisonStore implements ShadowComparisonStore {
  private results: ShadowComparisonResult[] = [];

  async save(result: ShadowComparisonResult): Promise<ShadowComparisonResult> {
    const stored = { ...result };
    this.results.push(stored);
    return { ...stored };
  }

  async findByGroup(groupId: string): Promise<ShadowComparisonResult[]> {
    return this.results
      .filter((r) => r.comparisonGroupId === groupId)
      .map((r) => ({ ...r }));
  }

  async getAll(): Promise<ShadowComparisonResult[]> {
    return this.results.map((r) => ({ ...r }));
  }

  async listForTenant(
    tenantId: string,
    opts: ShadowComparisonListOptions = {}
  ): Promise<ShadowComparisonPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let rows = this.results
      .filter((r) => r.tenantId === tenantId)
      .filter((r) => !opts.taskType || r.taskType === opts.taskType)
      .sort((a, b) => b.sampledAt.getTime() - a.sampledAt.getTime());

    if (opts.cursor) {
      const cursorTime = new Date(opts.cursor).getTime();
      rows = rows.filter((r) => r.sampledAt.getTime() < cursorTime);
    }

    const page = rows.slice(0, limit);
    const nextCursor =
      page.length === limit && rows.length > limit
        ? page[page.length - 1].sampledAt.toISOString()
        : null;

    return { comparisons: page.map((r) => ({ ...r })), nextCursor };
  }
}

export class ShadowComparisonGateway implements LLMProvider {
  public readonly name: string;
  private readonly primaryProvider: LLMProvider;
  private readonly shadowProvider: LLMProvider;
  private readonly store: ShadowComparisonStore;
  private readonly config: ShadowComparisonConfig;
  private readonly sampleFn: () => number;
  private comparisonCount: number = 0;

  constructor(
    primaryProvider: LLMProvider,
    shadowProvider: LLMProvider,
    store: ShadowComparisonStore,
    config: ShadowComparisonConfig
  ) {
    this.name = primaryProvider.name;
    this.primaryProvider = primaryProvider;
    this.shadowProvider = shadowProvider;
    this.store = store;
    this.config = config;
    this.sampleFn = config.sampleFn || Math.random;
  }

  async isAvailable(): Promise<boolean> {
    return this.primaryProvider.isAvailable();
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const primaryResponse = await this.primaryProvider.complete(request);

    // Image-bearing requests are excluded from shadow sampling: vision calls
    // are expensive (sampling double-bills them) and the shadow model may be
    // text-only, which would only record a spurious shadowError.
    if (
      this.config.enabled &&
      !messagesContainImage(request.messages) &&
      this.sampleFn() < this.config.samplingRate
    ) {
      const comparisonGroupId = uuidv4();
      let shadowResponse: LLMResponse | undefined;
      let shadowError: string | undefined;

      try {
        shadowResponse = await this.shadowProvider.complete(request);
      } catch (err) {
        shadowError = err instanceof Error ? err.message : String(err);
      }

      // Extract aiRunId from request metadata if present (set by gateway.ts P2-027).
      const aiRunId = request.metadata?.aiRunId as string | undefined;

      const result: ShadowComparisonResult = {
        id: uuidv4(),
        comparisonGroupId,
        taskType: request.taskType,
        primaryResponse,
        shadowResponse,
        shadowError,
        sampledAt: new Date(),
        tenantId: request.tenantId,
        aiRunId,
      };

      await this.store.save(result);
      this.comparisonCount++;
    }

    return primaryResponse;
  }

  getComparisonCount(): number {
    return this.comparisonCount;
  }
}
