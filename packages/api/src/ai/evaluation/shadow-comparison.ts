import { v4 as uuidv4 } from 'uuid';
import { LLMRequest, LLMResponse, LLMProvider } from '../gateway/gateway';

export interface ShadowComparisonResult {
  id: string;
  comparisonGroupId: string;
  taskType: string;
  primaryResponse: LLMResponse;
  shadowResponse?: LLMResponse;
  shadowError?: string;
  sampledAt: Date;
}

export interface ShadowComparisonConfig {
  enabled: boolean;
  samplingRate: number; // 0-1, default 0.1
  shadowProvider: string;
  sampleFn?: () => number;
}

export interface ShadowComparisonStore {
  save(result: ShadowComparisonResult): Promise<ShadowComparisonResult>;
  findByGroup(groupId: string): Promise<ShadowComparisonResult[]>;
  getAll(): Promise<ShadowComparisonResult[]>;
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

    if (this.config.enabled && this.sampleFn() < this.config.samplingRate) {
      const comparisonGroupId = uuidv4();
      let shadowResponse: LLMResponse | undefined;
      let shadowError: string | undefined;

      try {
        shadowResponse = await this.shadowProvider.complete(request);
      } catch (err) {
        shadowError = err instanceof Error ? err.message : String(err);
      }

      const result: ShadowComparisonResult = {
        id: uuidv4(),
        comparisonGroupId,
        taskType: request.taskType,
        primaryResponse,
        shadowResponse,
        shadowError,
        sampledAt: new Date(),
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
