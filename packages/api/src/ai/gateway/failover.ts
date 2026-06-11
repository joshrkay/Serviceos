import { LLMRequest, LLMResponse, LLMGateway } from './gateway';
import { ProviderHealthMonitor } from './health';
import { FeatureFlagStore, isFeatureEnabled } from '../../flags/feature-flags';
import { AppError } from '../../shared/errors';
import {
  CircuitBreakerRegistry,
  BreakerOpenError,
  type BreakerKeyParts,
} from './breaker';
import { runWithRetry, DEFAULT_RETRY, type RetryPolicy } from './retry';
import { adoptDeadline, STAGE_BUDGETS } from './deadline';
import { gatewayFallbackActivationsTotal } from '../../monitoring/metrics';

export type FallbackStage =
  | 'primary'
  | 'cheaper-model'
  | 'fallback-provider'
  | 'cached'
  | 'error-envelope';

export interface FailoverGatewayOptions {
  flagStore?: FeatureFlagStore;
  breakers?: CircuitBreakerRegistry;
  retryPolicy?: RetryPolicy;
  /** Optional cheaper-model variant on the primary, for first cascading step. */
  primaryCheaperModel?: string;
  /** Default total deadline in ms. */
  defaultDeadlineMs?: number;
  environment?: string;
  modelFamilyOf?: (model: string | undefined) => string;
}

/**
 * Resilience-aware gateway with breaker, retry, deadline, and cascading
 * fallback. The output `LLMResponse.degraded`/`fallbackStage`/`providerPath`
 * fields tell callers which path produced the result so they can render
 * appropriate UI/copy.
 */
export class FailoverGateway {
  private readonly primary: LLMGateway;
  private readonly fallback: LLMGateway;
  private readonly healthMonitor: ProviderHealthMonitor;
  private readonly flagStore?: FeatureFlagStore;
  private readonly breakers: CircuitBreakerRegistry;
  private readonly retryPolicy: RetryPolicy;
  private readonly primaryCheaperModel?: string;
  private readonly defaultDeadlineMs: number;
  private readonly environment: string;
  private readonly modelFamilyOf: (model: string | undefined) => string;
  private failoverCount: number = 0;

  constructor(
    primary: LLMGateway,
    fallback: LLMGateway,
    healthMonitor: ProviderHealthMonitor,
    flagStoreOrOpts?: FeatureFlagStore | FailoverGatewayOptions,
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.healthMonitor = healthMonitor;

    const opts: FailoverGatewayOptions =
      flagStoreOrOpts && 'getFlag' in (flagStoreOrOpts as FeatureFlagStore)
        ? { flagStore: flagStoreOrOpts as FeatureFlagStore }
        : ((flagStoreOrOpts as FailoverGatewayOptions) ?? {});

    this.flagStore = opts.flagStore;
    this.breakers = opts.breakers ?? new CircuitBreakerRegistry();
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY;
    this.primaryCheaperModel = opts.primaryCheaperModel;
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? STAGE_BUDGETS.defaultTotal;
    this.environment = opts.environment ?? process.env.NODE_ENV ?? 'development';
    this.modelFamilyOf =
      opts.modelFamilyOf ??
      ((m) => (m ?? 'unknown').split(/[/-]/, 1)[0] || 'unknown');
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const tenantContext = {
      environment: this.environment,
      tenantId: request.tenantId,
    };

    const breakerEnforced = this.flagOn('gateway.breaker_enforcement', tenantContext);
    const retryEnabled = this.flagOn('gateway.retry_enabled', tenantContext);
    const fallbackEnabled = this.flagOn('gateway.fallback_enabled', tenantContext);
    const forcePrimary = this.flagStore
      ? isFeatureEnabled(this.flagStore, 'force_primary_provider', tenantContext)
      : false;

    // Adopt or create a deadline. If the caller already passed a signal, the
    // local timer fires whichever comes first.
    const totalMs = request.deadlineMs ?? this.defaultDeadlineMs;
    const deadline = adoptDeadline(totalMs, request.signal);

    const path: string[] = [];
    const tier = request.tenantTier ?? 'standard';

    const tryPrimary = (model?: string, stage: FallbackStage = 'primary') => {
      const targetModel = model ?? request.model;
      const providerName = 'primary';
      const breakerParts: BreakerKeyParts = {
        provider: providerName,
        modelFamily: this.modelFamilyOf(targetModel),
        tenantTier: tier,
      };
      const localReq: LLMRequest = {
        ...request,
        model: targetModel,
        signal: deadline.signal,
        deadlineMs: deadline.remainingMs(),
      };
      const op = async () => {
        path.push(`primary:${targetModel ?? 'default'}`);
        const startTime = Date.now();
        try {
          const response = await this.primary.complete(localReq);
          this.healthMonitor.recordResult(providerName, Date.now() - startTime, true);
          return this.annotate(response, stage, path, /*degraded*/ stage !== 'primary');
        } catch (err) {
          this.healthMonitor.recordResult(providerName, Date.now() - startTime, false);
          throw err;
        }
      };
      const wrapped = breakerEnforced
        ? () => this.breakers.run(breakerParts, op)
        : op;
      if (retryEnabled) {
        return runWithRetry(wrapped, {
          policy: this.retryPolicy,
          deadline,
          provider: providerName,
          taskType: request.taskType,
        });
      }
      return wrapped();
    };

    const tryFallback = (stage: FallbackStage = 'fallback-provider') => {
      this.failoverCount++;
      gatewayFallbackActivationsTotal.inc({ stage });
      const breakerParts: BreakerKeyParts = {
        provider: 'fallback',
        modelFamily: this.modelFamilyOf(request.model),
        tenantTier: tier,
      };
      const localReq: LLMRequest = {
        ...request,
        signal: deadline.signal,
        deadlineMs: deadline.remainingMs(),
      };
      const op = async () => {
        path.push('fallback');
        const startTime = Date.now();
        try {
          const response = await this.fallback.complete(localReq);
          this.healthMonitor.recordResult('fallback', Date.now() - startTime, true);
          return this.annotate(response, stage, path, true);
        } catch (err) {
          this.healthMonitor.recordResult('fallback', Date.now() - startTime, false);
          throw err;
        }
      };
      const wrapped = breakerEnforced
        ? () => this.breakers.run(breakerParts, op)
        : op;
      if (retryEnabled) {
        return runWithRetry(wrapped, {
          policy: this.retryPolicy,
          deadline,
          provider: 'fallback',
          taskType: request.taskType,
        });
      }
      return wrapped();
    };

    try {
      // Stage 1: primary, default model.
      const primaryHealthy = this.healthMonitor.isHealthy('primary');
      if (forcePrimary || primaryHealthy) {
        try {
          return await tryPrimary();
        } catch (err) {
          if (forcePrimary) throw err;
          if (!fallbackEnabled) throw err;
          // Stage 2: same provider, cheaper/faster model variant.
          if (this.primaryCheaperModel) {
            gatewayFallbackActivationsTotal.inc({ stage: 'cheaper-model' });
            try {
              return await tryPrimary(this.primaryCheaperModel, 'cheaper-model');
            } catch {
              // fall through to fallback provider
            }
          }
        }
      }

      if (!fallbackEnabled) {
        throw new AppError(
          'PRIMARY_PROVIDER_UNAVAILABLE',
          'Primary provider unhealthy and fallback disabled by flag',
          503,
        );
      }

      // Stage 3: alternate provider.
      try {
        return await tryFallback();
      } catch (fallbackErr) {
        // Stage 4: explicit degraded error envelope.
        const retryAfterMs =
          fallbackErr instanceof BreakerOpenError ? fallbackErr.retryAfterMs : 1_000;
        gatewayFallbackActivationsTotal.inc({ stage: 'error-envelope' });
        throw new AppError(
          'ALL_PROVIDERS_FAILED',
          `All providers failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          502,
          {
            degraded: true,
            providerPath: path,
            retryAfterMs,
          },
        );
      }
    } finally {
      deadline.abort();
    }
  }

  getFailoverCount(): number {
    return this.failoverCount;
  }

  private annotate(
    response: LLMResponse,
    stage: FallbackStage,
    providerPath: string[],
    degraded: boolean,
  ): LLMResponse {
    return {
      ...response,
      degraded,
      fallbackStage: stage,
      providerPath: [...providerPath],
    };
  }

  private flagOn(
    name: string,
    ctx: { environment: string; tenantId?: string },
  ): boolean {
    if (!this.flagStore) {
      // Default-on for resilience flags when no store is configured (tests).
      // Production callers always provide a store; flags are evaluated there.
      return true;
    }
    return isFeatureEnabled(this.flagStore, name, ctx);
  }
}
