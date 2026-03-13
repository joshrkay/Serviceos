import { LLMRequest, LLMResponse, LLMGateway } from './gateway';
import { ProviderHealthMonitor } from './health';
import { FeatureFlagStore, isFeatureEnabled } from '../../flags/feature-flags';
import { AppError } from '../../shared/errors';

export class FailoverGateway {
  private readonly primary: LLMGateway;
  private readonly fallback: LLMGateway;
  private readonly healthMonitor: ProviderHealthMonitor;
  private readonly flagStore?: FeatureFlagStore;
  private failoverCount: number = 0;

  constructor(
    primary: LLMGateway,
    fallback: LLMGateway,
    healthMonitor: ProviderHealthMonitor,
    flagStore?: FeatureFlagStore
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.healthMonitor = healthMonitor;
    this.flagStore = flagStore;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const forcePrimary = this.flagStore
      ? isFeatureEnabled(this.flagStore, 'force_primary_provider', { environment: 'prod' })
      : false;

    const primaryHealthy = this.healthMonitor.isHealthy('primary');

    if (forcePrimary || primaryHealthy) {
      const startTime = Date.now();
      try {
        const response = await this.primary.complete(request);
        const latencyMs = Date.now() - startTime;
        this.healthMonitor.recordResult('primary', latencyMs, true);
        return response;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        this.healthMonitor.recordResult('primary', latencyMs, false);

        if (forcePrimary) {
          throw err;
        }

        // Fall through to fallback
      }
    }

    // Use fallback
    this.failoverCount++;

    const fallbackStart = Date.now();
    try {
      const response = await this.fallback.complete(request);
      const latencyMs = Date.now() - fallbackStart;
      this.healthMonitor.recordResult('fallback', latencyMs, true);
      return response;
    } catch (fallbackErr) {
      const latencyMs = Date.now() - fallbackStart;
      this.healthMonitor.recordResult('fallback', latencyMs, false);

      throw new AppError(
        'ALL_PROVIDERS_FAILED',
        `All providers failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        502
      );
    }
  }

  getFailoverCount(): number {
    return this.failoverCount;
  }
}
