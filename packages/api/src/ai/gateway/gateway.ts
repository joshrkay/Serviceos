import { createHash } from 'crypto';
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
import { AIRoutingConfig, isVisionCapableModel } from '../../config/ai-routing';
import {
  resolveRouting,
  shouldWarnForUnmappedTaskType,
} from './router';

/** A text part of a multimodal message. */
export interface LLMTextContentBlock {
  type: 'text';
  text: string;
}

/**
 * An image part of a multimodal message. `url` may be an https URL or a
 * `data:` URI. Image URLs/bytes are redacted from ai_run snapshots
 * (see `redactMessagesForSnapshot`) to avoid PII at rest.
 */
export interface LLMImageContentBlock {
  type: 'image_url';
  image_url: { url: string };
}

export type LLMContentBlock = LLMTextContentBlock | LLMImageContentBlock;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * Plain text, or an ordered list of content blocks for multimodal
   * (vision) requests. Only `user` messages should carry image blocks.
   */
  content: string | LLMContentBlock[];
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

// Accepts an image data URL with optional RFC-2397 params before ;base64,
// e.g. "data:image/png;base64," and "data:image/png;name=x.png;base64,".
const DATA_URL_IMAGE_RE = /^data:image\/[a-zA-Z0-9.+-]+(?:;[a-zA-Z0-9.+=-]+)*;base64,/i;

/** True for an http(s) URL or a base64 image data URL. */
function isValidImageUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  return /^https?:\/\//i.test(url) || DATA_URL_IMAGE_RE.test(url);
}

/** Validate one message's optional multimodal `parts` array. */
function validateContentParts(message: LLMMessage, index: number): string[] {
  const errors: string[] = [];
  const parts = message.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    errors.push(`messages[${index}].parts must be a non-empty array when present`);
    return errors;
  }
  parts.forEach((rawPart, p) => {
    const u: unknown = rawPart;
    if (u === null || typeof u !== 'object') {
      errors.push(`messages[${index}].parts[${p}]: must be a content part object`);
      return;
    }
    const part = u as { type?: unknown; text?: unknown; url?: unknown };
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0) {
        errors.push(`messages[${index}].parts[${p}]: text part requires non-empty text`);
      }
      return;
    }
    if (part.type === 'image') {
      if (message.role !== 'user') {
        errors.push(`messages[${index}].parts[${p}]: image parts are only allowed on user messages`);
      }
      if (!isValidImageUrl(part.url)) {
        errors.push(`messages[${index}].parts[${p}]: image url must be an http(s) or data:image/...;base64 URL`);
      }
      return;
    }
    errors.push(`messages[${index}].parts[${p}]: unknown content part type "${String(part.type)}"`);
  });
  return errors;
}

export function validateLLMRequest(request: LLMRequest): string[] {
  const errors: string[] = [];
  if (!request.taskType) errors.push('taskType is required');
  if (!request.messages || !Array.isArray(request.messages) || request.messages.length === 0) {
    errors.push('messages must be a non-empty array');
  } else {
    request.messages.forEach((m, i) => {
      if (Array.isArray(m.content)) {
        if (m.content.length === 0) {
          errors.push(`messages[${i}].content array must be non-empty`);
        }
        m.content.forEach((block, j) => {
          if (block.type === 'image_url') {
            if (!block.image_url || typeof block.image_url.url !== 'string' || block.image_url.url.length === 0) {
              errors.push(`messages[${i}].content[${j}] image_url.url is required`);
            }
          } else if (block.type === 'text') {
            if (typeof block.text !== 'string') {
              errors.push(`messages[${i}].content[${j}] text must be a string`);
            }
          } else {
            errors.push(`messages[${i}].content[${j}] has an unknown block type`);
          }
        });
      } else if (typeof m.content !== 'string') {
        errors.push(`messages[${i}].content must be a string or a content-block array`);
      }
    });
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
  if (Array.isArray(request.messages)) {
    request.messages.forEach((message, index) => {
      if (message.parts !== undefined) {
        errors.push(...validateContentParts(message, index));
      }
    });
  }
  return errors;
}

/**
 * Redact image payloads (URLs / data URIs) from messages before they are
 * written to an ai_runs input snapshot. Text is preserved for debugging;
 * image content is replaced with a placeholder to avoid PII at rest.
 */
export function redactMessagesForSnapshot(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          role: m.role,
          content: m.content.map((b) =>
            b.type === 'image_url'
              ? { type: 'image_url' as const, image_url: { url: '[redacted-image]' } }
              : b,
          ),
        }
      : m,
  );
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

    // Fail fast: an image-bearing request must resolve to a vision-capable
    // model. Throwing here (before the ai_run row and provider dispatch)
    // avoids an opaque provider 400 and leaves no orphaned state.
    if (messagesContainImage(request.messages) && !isVisionCapableModel(resolvedModel)) {
      throw new ValidationError(
        'LLM request includes image content but the resolved model is not vision-capable',
        { taskType: request.taskType, resolvedModel },
      );
    }

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
            messages: redactMessagesForSnapshot(request.messages),
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
