import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AppError, ValidationError } from '../../shared/errors';
import {
  gatewayRequestLatencyMs,
  gatewayRequestsTotal,
  gatewayRequestCostMicroCentsTotal,
} from '../../monitoring/metrics';
import {
  AiRunRepository,
  createAiRun,
  completeAiRun,
  failAiRun,
  AiRun,
} from '../ai-run';
import { AIRoutingConfig, isVisionCapableModel, resolveTierDeadlineMs, TASK_TYPES } from '../../config/ai-routing';
import {
  resolveRouting,
  shouldWarnForUnmappedTaskType,
} from './router';
import { computeCostMicroCents } from './model-pricing';

/** Image detail hint passed through to vision-capable providers. */
export type LLMImageDetail = 'low' | 'high' | 'auto';

/** A text part of a multimodal message. */
export interface LLMTextPart {
  type: 'text';
  text: string;
}

/**
 * An image part of a multimodal message. `url` may be an https URL or a
 * `data:image/...;base64,` URI. Image URLs/bytes are redacted from ai_run
 * snapshots (see `redactMessagesForSnapshot`) to avoid PII at rest.
 */
export interface LLMImagePart {
  type: 'image';
  url: string;
  detail?: LLMImageDetail;
}

export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain text content. */
  content: string;
  /**
   * Optional ordered multimodal parts (text / image) for vision requests.
   * Only `user` messages may carry image parts. The provider sends `content`
   * (when non-empty) followed by these parts.
   */
  parts?: LLMContentPart[];
}

/**
 * True when any message carries an image part (drives vision-model routing).
 * Robust to malformed `parts` (non-array / null elements) — never throws.
 */
export function messagesContainImage(messages: LLMMessage[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.parts) && m.parts.some((p) => p != null && p.type === 'image'),
  );
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
  /**
   * Id of the persisted `ai_runs` row for THIS completion. Present only when
   * an `AiRunRepository` is wired AND the row was created successfully
   * (creation is best-effort). Callers thread this into downstream records —
   * e.g. the voice classifier surfaces it so a voice proposal can satisfy
   * `proposals.ai_run_id`'s FK with a REAL run id instead of null. Undefined
   * when no repo is configured or the best-effort create failed.
   */
  aiRunId?: string;
  /**
   * Cost of this call in micro-cents (1 cent = 1,000,000 micro-cents — see
   * `ai/gateway/model-pricing.ts` for the precision rationale). `null` when
   * the resolved model has no known price (never a guessed cost). Absent
   * only if cost computation itself was skipped (e.g. the error path, which
   * never populates this field).
   */
  costMicroCents?: number | null;
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

/**
 * taskTypes carried in the canonical `TASK_TYPES` list purely so the
 * lightweight/standard/complex tier mapping in `config/ai-routing.ts` covers
 * them, but whose ONLY real call sites are the offline voice-quality eval
 * harness (`ai/voice-quality/**`) grading synthetic transcripts — never a
 * live tenant call. Carved out of `TENANT_SCOPED_TASK_TYPES` below so the
 * guard doesn't demand a tenantId that genuinely doesn't exist for these.
 * If a real per-tenant call site for one of these is ever added, remove it
 * from this set (the guard should track it like every other taskType).
 */
const HARNESS_ONLY_TASK_TYPES: ReadonlySet<string> = new Set([
  'voice_quality_judge',
  'voice_quality_perceived_completion',
  'voice_quality_reprompt_judge',
]);

/**
 * Known tenant-scoped task types — the canonical `TASK_TYPES` list from
 * `config/ai-routing.ts` (every value a real call site passes to
 * `gateway.complete({ taskType })`), minus `HARNESS_ONLY_TASK_TYPES` above.
 * Every remaining entry is per-tenant voice/AI work; none of them is a
 * legitimately system-level task. Used only as a conservative allow-list for
 * `enforceTopLevelTenantId` below — dynamically-constructed taskTypes (e.g.
 * the `assistant.*` namespace) are intentionally excluded so we don't
 * warn/throw for taskTypes this list doesn't know about.
 */
const TENANT_SCOPED_TASK_TYPES: ReadonlySet<string> = new Set(
  TASK_TYPES.filter((t) => !HARNESS_ONLY_TASK_TYPES.has(t)),
);

/**
 * P0 scaling bug guard: a tenant-scoped taskType dispatched with no
 * top-level `tenantId` silently falls back to the shared `SYSTEM_TENANT_ID`
 * bucket in the resilience wrappers (`ProviderTenantQuotaWrapper` /
 * `CachingGatewayWrapper` both key on `request.tenantId`, not
 * `request.metadata.tenantId`) — collapsing every tenant's concurrency quota
 * onto one process-global bucket, and (if the gateway cache is ever enabled)
 * leaking cached classifications/entities across tenants.
 *
 * Escalation: production defaults to a WARNING, not a hard throw, because
 * some call sites can still (legitimately, or pending a fix) omit the
 * top-level field and a throw there would 500 a real user-facing request
 * rather than degrade to the shared bucket. Test/dev/CI default to a hard
 * THROW instead — the same silent-fallback bug is far cheaper to catch in a
 * failing test than in a production quota/cache incident, and every known
 * call site has been fixed to pass tenantId (see gateway.test.ts's sweep
 * test). Override either way with `AI_GATEWAY_STRICT_TENANT_ID=true|false`.
 */
function isStrictTenantIdModeEnabled(): boolean {
  const raw = process.env.AI_GATEWAY_STRICT_TENANT_ID;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return (process.env.NODE_ENV ?? 'development') !== 'production';
}

/** Thrown by `enforceTopLevelTenantId` in strict mode (see above). */
export class MissingTenantIdError extends ValidationError {
  constructor(public readonly taskType: string) {
    super(
      `LLM request for tenant-scoped taskType "${taskType}" is missing a top-level tenantId. ` +
        'Pass { tenantId } at the top level of the gateway.complete() request — putting it only ' +
        'in metadata silently shares the SYSTEM_TENANT_ID quota/cache bucket across every tenant. ' +
        'Set AI_GATEWAY_STRICT_TENANT_ID=false to downgrade this to a warning (e.g. for a known, ' +
        'not-yet-fixed call site).',
      { taskType },
    );
    this.name = 'MissingTenantIdError';
  }
}

function enforceTopLevelTenantId(
  request: LLMRequest,
  logger?: LLMGatewayLogger,
): void {
  if (request.tenantId) return;
  if (!TENANT_SCOPED_TASK_TYPES.has(request.taskType)) return;

  if (isStrictTenantIdModeEnabled()) {
    throw new MissingTenantIdError(request.taskType);
  }

  const metadataTenantId =
    request.metadata && typeof request.metadata === 'object'
      ? (request.metadata as Record<string, unknown>).tenantId
      : undefined;
  logger?.info(
    'LLM request for a tenant-scoped taskType is missing a top-level tenantId — ' +
      'falling back to the shared "system" quota/cache bucket for this call',
    {
      level: 'warn',
      taskType: request.taskType,
      hasMetadataTenantId: metadataTenantId !== undefined,
    },
  );
}

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
/**
 * Redact one image part for the ai_run snapshot — never store the raw URL or
 * bytes. For a base64 data: URL we keep mimeType + byte count; for any URL we
 * keep a sha256 reference so identical images stay correlatable in the audit.
 */
function redactImagePart(part: LLMImagePart): Record<string, unknown> {
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i.exec(part.url);
  if (dataUrl) {
    const bytes = Buffer.from(dataUrl[2], 'base64');
    return {
      type: 'image',
      redacted: true,
      mimeType: dataUrl[1],
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(part.detail ? { detail: part.detail } : {}),
    };
  }
  return {
    type: 'image',
    redacted: true,
    sha256: createHash('sha256').update(part.url).digest('hex'),
    ...(part.detail ? { detail: part.detail } : {}),
  };
}

export function redactMessagesForSnapshot(
  messages: LLMMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m): Record<string, unknown> => {
    if (!m.parts || m.parts.length === 0) {
      return { role: m.role, content: m.content };
    }
    return {
      role: m.role,
      content: m.content,
      parts: m.parts.map((p) =>
        p.type === 'image' ? redactImagePart(p) : { type: 'text', text: p.text },
      ),
    };
  });
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

    enforceTopLevelTenantId(request, this.logger);

    const providerName = this.resolveProvider(request.taskType);
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', `Provider not found: ${providerName}`, 500);
    }

    const tenantId = request.tenantId ?? SYSTEM_TENANT_ID;
    // AI_DEFAULT_MODEL is wired by createLLMGateway as a SYSTEM_TENANT_ID
    // override (factory.ts). That override must apply to every tenant that
    // has no explicit override — otherwise real traffic silently uses
    // DEFAULT_AI_ROUTING_CONFIG (Claude/Llama defaults) while ops believe
    // AI_DEFAULT_MODEL=gpt-4o-mini is in effect. Live incident 2026-07-20:
    // OpenAI host + Claude model ids → 100% gateway errors.
    const tenantOverride = this.config.tenantOverrides
      ? (this.config.tenantOverrides[tenantId] ??
        (tenantId !== SYSTEM_TENANT_ID
          ? this.config.tenantOverrides[SYSTEM_TENANT_ID]
          : undefined))
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
      // VOX-34: apply the resolved tier's default end-to-end deadline when the
      // caller didn't set one. Without this, every request (including
      // classify_intent on the voice hot path) inherited the universal 8s
      // fallback in ProviderRetryDeadlineWrapper — far above the turn SLO.
      // An explicit request.deadlineMs always wins. The retry layer still
      // enforces MIN_RETRY_BUDGET_MS against this (now tighter) budget.
      deadlineMs: request.deadlineMs ?? resolveTierDeadlineMs(routingDecision.resolvedTier),
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

      // Cost accounting (per-tenant/per-task spend telemetry). Computed from
      // the model that ACTUALLY served the request — `response.model`, which
      // the resilience layer rewrites on a cheaper-model or fallback-provider
      // failover (e.g. a Sonnet route that fails over to Haiku) — not the
      // originally-resolved route. Using resolvedModel here would bill a
      // failover at the wrong rate, or record null when an unpriced primary
      // succeeded on a priced fallback. Falls back to resolvedModel only if a
      // provider omitted the field. null when the model has no known price
      // (see model-pricing.ts); the metric below is simply not incremented in
      // that case rather than by a fabricated amount.
      const costModel = response.model || resolvedModel;
      const costProvider = response.provider || providerName;
      const costMicroCents = computeCostMicroCents(costModel, response.tokenUsage);

      const result: LLMResponse = {
        ...response,
        latencyMs,
        // Surface the persisted ai_runs id so callers can link downstream
        // records (e.g. proposals.ai_run_id) to a REAL run row. Present only
        // when the best-effort create above succeeded.
        ...(aiRun ? { aiRunId: aiRun.id } : {}),
        costMicroCents,
      };

      const labels = {
        tenant_tier: tier,
        model: resolvedModel,
        provider: providerName,
        outcome: result.degraded ? 'degraded' : 'success',
        task_type: request.taskType,
      };
      gatewayRequestsTotal.inc(labels);
      gatewayRequestLatencyMs.observe(labels, latencyMs);
      if (costMicroCents !== null) {
        // Attribute spend to the model/provider that actually served the
        // request (post-failover), matching the cost figure above.
        gatewayRequestCostMicroCentsTotal.inc(
          {
            tenant_tier: tier,
            task_type: request.taskType,
            model: costModel,
            provider: costProvider,
          },
          costMicroCents,
        );
      }

      this.logger?.info('LLM completion succeeded', {
        taskType: request.taskType,
        provider: providerName,
        model: resolvedModel,
        latencyMs,
        tokenUsage: result.tokenUsage,
        costMicroCents,
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
            result.tokenUsage,
            costMicroCents
          );
          await this.aiRunRepo.updateStatus(tenantId, aiRun.id, 'completed', {
            outputSnapshot: completedRun.outputSnapshot,
            tokenUsage: result.tokenUsage,
            completedAt: completedRun.completedAt,
            durationMs: completedRun.durationMs,
            costMicroCents,
            // Persist the model that actually served the request (post-
            // failover) so per-model spend aggregations over ai_runs match
            // costMicroCents, which is priced at costModel's rates — not
            // resolvedModel, which the row was created with before dispatch.
            model: costModel,
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
        task_type: request.taskType,
      });
      gatewayRequestLatencyMs.observe(
        {
          tenant_tier: tier,
          model: resolvedModel,
          provider: providerName,
          outcome: 'error',
          task_type: request.taskType,
        },
        latencyMs,
      );
      this.logger?.error('LLM completion failed', {
        // Story 3.12 — correlationId on the failure log so a model/tool error
        // is traceable end-to-end (it keys the ai_runs row written below).
        correlationId,
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
            correlationId,
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
