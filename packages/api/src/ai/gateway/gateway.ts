import { v4 as uuidv4 } from 'uuid';
import { AppError, ValidationError } from '../../shared/errors';
import {
  gatewayRequestLatencyMs,
  gatewayRequestsTotal,
} from '../../monitoring/metrics';
import {
  AiRunRepository,
  createAiRun,
  completeAiRun,
  failAiRun,
  AiRun,
} from '../ai-run';
import { AIRoutingConfig } from '../../config/ai-routing';
import {
  resolveRouting,
  shouldWarnForUnmappedTaskType,
} from './router';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  taskType: string;
  model?: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  metadata?: Record<string, unknown>;
  /** Per-request end-to-end budget in ms. Honored by the resilience layer. */
  deadlineMs?: number;
  /** AbortSignal injected by the resilience layer for cooperative cancellation. */
  signal?: AbortSignal;
  /** Tenant tier (free|standard|premium) — drives quota + breaker cell. */
  tenantTier?: string;
  /** Tenant id; usually populated from tenantContextStore on the gateway side. */
  tenantId?: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  tokenUsage: { input: number; output: number; total: number };
  latencyMs: number;
  cached?: boolean;
  /** True when the response was served via a fallback path or coalesced. */
  degraded?: boolean;
  /** Stage that produced this response: 'primary' | 'cheaper-model' | 'fallback-provider' | 'cached' | 'error-envelope'. */
  fallbackStage?: string;
  /** Ordered list of provider attempts (provider/model) for tracing. */
  providerPath?: string[];
  /** Hint to clients when degraded; ms until they should retry. */
  retryAfterMs?: number;
}

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

export interface LLMGatewayConfig {
  defaultProvider: string;
  taskRouting?: Record<string, string>; // taskType -> providerName
  defaultModel?: string;
  taskModels?: Record<string, string>; // taskType -> model
  /**
   * Per-tenant routing config overrides.
   * Keys are tenantIds; values are partial AIRoutingConfig merged over the
   * DEFAULT_AI_ROUTING_CONFIG before resolving model/tier.
   * P2-028: tenant-level model tier overrides.
   */
  tenantOverrides?: Record<string, Partial<AIRoutingConfig>>;
}

export interface LLMGatewayLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Sentinel tenant ID used when a request carries no tenantId. */
export const SYSTEM_TENANT_ID = 'system';

export function validateLLMRequest(request: LLMRequest): string[] {
  const errors: string[] = [];
  if (!request.taskType) errors.push('taskType is required');
  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    errors.push('messages must be a non-empty array');
  }
  if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
    errors.push('temperature must be between 0 and 2');
  }
  if (request.maxTokens !== undefined && request.maxTokens <= 0) {
    errors.push('maxTokens must be a positive number');
  }
  if (request.responseFormat !== undefined && request.responseFormat !== 'text' && request.responseFormat !== 'json') {
    errors.push('responseFormat must be "text" or "json"');
  }
  return errors;
}

export class LLMGateway {
  private readonly config: LLMGatewayConfig;
  private readonly providers: Map<string, LLMProvider>;
  private readonly logger?: LLMGatewayLogger;
  private readonly aiRunRepo?: AiRunRepository;

  constructor(
    config: LLMGatewayConfig,
    providers: Map<string, LLMProvider>,
    logger?: LLMGatewayLogger,
    aiRunRepo?: AiRunRepository
  ) {
    this.config = config;
    this.providers = providers;
    this.logger = logger;
    this.aiRunRepo = aiRunRepo;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const validationErrors = validateLLMRequest(request);
    if (validationErrors.length > 0) {
      throw new ValidationError('Invalid LLM request', { errors: validationErrors });
    }

    const providerName = this.resolveProvider(request.taskType);
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', `Provider not found: ${providerName}`, 500);
    }

    const tenantId = request.tenantId ?? SYSTEM_TENANT_ID;
    const tenantOverride = this.config.tenantOverrides
      ? this.config.tenantOverrides[tenantId]
      : undefined;

    // resolveRouting merges tenant config exactly once and also sets wasUnmapped
    // so the caller doesn't need to re-merge to check the task tier mapping.
    const routingDecision = resolveRouting(request, tenantOverride);
    const resolvedModel = routingDecision.resolvedModel;
    const resolvedRequest: LLMRequest = {
      ...request,
      model: resolvedModel,
      maxTokens: routingDecision.maxTokens,
      temperature: routingDecision.temperature,
    };

    // Warn once per process when taskType is not in the active tier mapping
    if (routingDecision.wasUnmapped && shouldWarnForUnmappedTaskType(request.taskType)) {
      this.logger?.info(`unmapped taskType "${request.taskType}" — defaulting to standard tier`, {
        taskType: request.taskType,
        resolvedTier: 'standard',
        level: 'warn',
      });
    }

    // Emit structured routing decision log
    this.logger?.info('model_routing_decision', {
      taskType: request.taskType,
      resolvedTier: routingDecision.resolvedTier,
      resolvedModel,
      overrideSource: routingDecision.overrideSource,
    });

    const startTime = Date.now();
    const tier = request.tenantTier ?? 'standard';

    // Resolve correlation ID: prefer metadata.correlationId, otherwise generate one
    const correlationId =
      (request.metadata?.correlationId as string | undefined) ?? uuidv4();
    const promptVersionId = request.metadata?.promptVersionId as string | undefined;

    // Create the ai_runs row (best-effort — failure must not abort the LLM call).
    // A single create() writes the run with status 'pending' and startedAt already
    // set, reflecting that we are about to dispatch the provider call immediately.
    let aiRun: AiRun | undefined;
    if (this.aiRunRepo) {
      try {
        const pendingRun = createAiRun({
          tenantId,
          taskType: request.taskType,
          model: resolvedModel,
          promptVersionId,
          inputSnapshot: {
            messages: request.messages,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
          },
          createdBy: 'gateway',
          correlationId,
        });
        // Set startedAt at creation time so the single DB write captures timing origin.
        const runAtCreation: AiRun = { ...pendingRun, startedAt: new Date(startTime) };
        aiRun = await this.aiRunRepo.create(runAtCreation);
      } catch (repoErr) {
        this.logger?.error('AI-run logging failed (best-effort, LLM call continues)', {
          error: repoErr instanceof Error ? repoErr.message : String(repoErr),
        });
        aiRun = undefined;
      }
    }

    try {
      const response = await provider.complete(resolvedRequest);
      const latencyMs = Date.now() - startTime;

      const result: LLMResponse = {
        ...response,
        latencyMs,
      };

      const labels = {
        tenant_tier: tier,
        model: resolvedModel,
        provider: providerName,
        outcome: result.degraded ? 'degraded' : 'success',
      };
      gatewayRequestsTotal.inc(labels);
      gatewayRequestLatencyMs.observe(labels, latencyMs);

      this.logger?.info('LLM completion succeeded', {
        taskType: request.taskType,
        provider: providerName,
        model: resolvedModel,
        latencyMs,
        tokenUsage: result.tokenUsage,
        degraded: result.degraded ?? false,
        fallbackStage: result.fallbackStage,
        providerPath: result.providerPath,
      });

      // Persist completed ai_run (best-effort).
      // Use completeAiRun to compute completedAt/durationMs so the DB values
      // match the Prometheus latency recorded above.
      // P2-029: include providerPath in outputSnapshot for postmortems.
      if (this.aiRunRepo && aiRun) {
        try {
          const outputFields: Record<string, unknown> = {
            content: result.content,
            provider: result.provider,
          };
          if (result.providerPath && result.providerPath.length > 0) {
            outputFields.providerPath = result.providerPath;
          }
          const completedRun = completeAiRun(
            aiRun,
            outputFields,
            result.tokenUsage
          );
          await this.aiRunRepo.updateStatus(tenantId, aiRun.id, 'completed', {
            outputSnapshot: completedRun.outputSnapshot,
            tokenUsage: result.tokenUsage,
            completedAt: completedRun.completedAt,
            durationMs: completedRun.durationMs,
          });
        } catch (repoErr) {
          this.logger?.error('AI-run completion logging failed (best-effort)', {
            error: repoErr instanceof Error ? repoErr.message : String(repoErr),
          });
        }
      }

      return result;
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      gatewayRequestsTotal.inc({
        tenant_tier: tier,
        model: resolvedModel,
        provider: providerName,
        outcome: 'error',
      });
      gatewayRequestLatencyMs.observe(
        {
          tenant_tier: tier,
          model: resolvedModel,
          provider: providerName,
          outcome: 'error',
        },
        latencyMs,
      );
      this.logger?.error('LLM completion failed', {
        taskType: request.taskType,
        provider: providerName,
        model: resolvedModel,
        latencyMs,
        error: err instanceof Error ? err.message : String(err),
      });

      // Persist failed ai_run (best-effort).
      // Use failAiRun to compute completedAt/durationMs consistently with the
      // success path so both match the Prometheus latency observation.
      if (this.aiRunRepo && aiRun) {
        try {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const failedRun = failAiRun(aiRun, errorMessage);
          await this.aiRunRepo.updateStatus(tenantId, aiRun.id, 'failed', {
            error: errorMessage,
            completedAt: failedRun.completedAt,
            durationMs: failedRun.durationMs,
          });
        } catch (repoErr) {
          this.logger?.error('AI-run failure logging failed (best-effort)', {
            error: repoErr instanceof Error ? repoErr.message : String(repoErr),
          });
        }
      }

      if (err instanceof AppError) {
        throw err;
      }

      throw new AppError(
        'LLM_PROVIDER_ERROR',
        `Provider ${providerName} failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
        { provider: providerName, taskType: request.taskType }
      );
    }
  }

  private resolveProvider(taskType: string): string {
    if (this.config.taskRouting && this.config.taskRouting[taskType]) {
      return this.config.taskRouting[taskType];
    }
    return this.config.defaultProvider;
  }

}
