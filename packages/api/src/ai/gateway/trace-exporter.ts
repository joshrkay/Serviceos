/**
 * U10 — LLM trace export (plan 2026-09-05-001, R10).
 *
 * A second sink behind the gateway seam, beside `ai_runs` (which stays the
 * tenant-scoped system of record — it feeds `proposals.ai_run_id`). Every
 * completion the gateway serves — success, failure, or cache hit — becomes
 * one Langfuse trace (id = the request's `correlationId`, grouped by the
 * request's `metadata.sessionId`) with one generation carrying tenant,
 * task, resolved + served model, provider path, prompt version, usage,
 * cost and latency, so a voice turn or chat exchange opens as ONE trace
 * instead of being reconstructed from Prometheus aggregates.
 *
 * Off by default: without BOTH LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY
 * the app gets the `NoopTraceExporter` and makes zero network calls (the
 * PostHog / Sentry posture). Prompt and reply content is exported ONLY when
 * LANGFUSE_CAPTURE_CONTENT=true — voice traces carry caller transcripts —
 * and then only after `redactContentForExport` (below).
 *
 * The `langfuse` SDK is resolved with a guarded dynamic require, exactly
 * like `monitoring/sentry.ts` resolves `@sentry/node`: keys configured but
 * module absent → noop plus one logged error, never a boot failure. This is
 * the ONLY module that touches the SDK.
 */
import { redactByTier } from '../../logging/redact';
import { redactPii } from '../../reputation/pii-redact';
import type { AppConfig } from '../../shared/config';
import { redactMessagesForSnapshot } from './gateway';
import type { LLMGatewayLogger, LLMMessage } from './gateway';

/** One completion as seen by the gateway (or the cache wrapper's hit branch). */
export interface LLMTraceCompletionEvent {
  /** Trace id — the request's correlationId (supplied or gateway-minted). */
  correlationId: string;
  tenantId: string;
  taskType: string;
  /** `request.metadata.sessionId` — groups a voice session / chat conversation. */
  sessionId?: string;
  /** Model the router resolved for the task. */
  resolvedModel: string;
  /** Model that actually served the call (post-failover); the cost basis. */
  servedModel: string;
  /** Provider that actually served the call. */
  provider: string;
  providerPath?: string[];
  fallbackStage?: string;
  cached: boolean;
  degraded: boolean;
  promptVersionId?: string;
  tokenUsage?: { input: number; output: number; total: number };
  /** Gateway unit (1 cent = 1,000,000 micro-cents); null = unpriced model. */
  costMicroCents?: number | null;
  latencyMs: number;
  startedAt: Date;
  /** Present only on the failure path. */
  error?: string;
  /** Raw request messages — redacted by the exporter, exported only on capture. */
  input: LLMMessage[];
  /** Raw reply content — redacted by the exporter, exported only on capture. */
  output?: string;
}

export interface LLMTraceExporter {
  /** Synchronous and best-effort: callers wrap it; a throw must never reach the completion. */
  recordCompletion(event: LLMTraceCompletionEvent): void;
  /** Drain queued events — awaited once at shutdown. Never rejects. */
  flush(): Promise<void>;
}

export class NoopTraceExporter implements LLMTraceExporter {
  recordCompletion(): void {}
  async flush(): Promise<void> {}
}

// ── Langfuse ──────────────────────────────────────────────────────────────────

/** The subset of the Langfuse trace body this exporter writes. */
export interface LangfuseTraceBody {
  id: string;
  name: string;
  sessionId?: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** The subset of the Langfuse generation body this exporter writes. */
export interface LangfuseGenerationBody {
  name: string;
  model: string;
  startTime: Date;
  endTime: Date;
  level: 'DEFAULT' | 'ERROR';
  statusMessage?: string;
  version?: string;
  usageDetails?: Record<string, number>;
  /** USD — the SDK's cost unit; converted from micro-cents at this boundary only. */
  costDetails?: Record<string, number>;
  metadata: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
}

/** Structural view of the `langfuse` client — what the exporter calls; tests inject a fake. */
export interface LangfuseClientLike {
  trace(body: LangfuseTraceBody): { generation(body: LangfuseGenerationBody): unknown };
  shutdownAsync(): Promise<void>;
}

export interface LangfuseClientOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

interface LangfuseModule {
  Langfuse: new (opts: LangfuseClientOptions) => LangfuseClientLike;
}

/** Guarded dynamic require (the `initSentry` shape): null when the SDK is not installed. */
function createLangfuseClient(opts: LangfuseClientOptions): LangfuseClientLike | null {
  let mod: LangfuseModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('langfuse') as LangfuseModule;
  } catch {
    return null;
  }
  return new mod.Langfuse(opts);
}

/** 1 cent = 1,000,000 micro-cents (model-pricing.ts); 1 USD = 100 cents. */
export function microCentsToUsd(microCents: number): number {
  return microCents / 100_000_000;
}

const REDACTED = '[REDACTED]';
/**
 * Inline credential shapes that `redactByTier` (key-based) cannot see inside
 * free text. Over-redaction is the safe direction for exported content.
 */
const INLINE_SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bbearer\s+\S+/gi, `Bearer ${REDACTED}`],
  [/\b(authorization|api[_-]?key)\b(\s*[:=]\s*)\S+/gi, `$1$2${REDACTED}`],
];

/** Free-text redaction for exported content: PII placeholders, then inline credentials. */
export function redactTextForExport(text: string): string {
  return INLINE_SECRET_PATTERNS.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    redactPii(text),
  );
}

function redactPart(part: unknown): unknown {
  if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
    return { ...(part as Record<string, unknown>), text: redactTextForExport((part as { text: string }).text) };
  }
  return part;
}

/**
 * The content contract: the `ai_runs` snapshot redaction (image bytes/URLs
 * out), free-text PII + inline-credential scrubbing on every text field,
 * then the strict key-tier pass over the whole structure.
 */
export function redactContentForExport(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const scrubbed = redactMessagesForSnapshot(messages).map((m) => ({
    ...m,
    ...(typeof m.content === 'string' ? { content: redactTextForExport(m.content) } : {}),
    ...(Array.isArray(m.parts) ? { parts: m.parts.map(redactPart) } : {}),
  }));
  return redactByTier(scrubbed, 'strict');
}

function buildTraceBody(event: LLMTraceCompletionEvent): LangfuseTraceBody {
  return {
    id: event.correlationId,
    name: event.taskType,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    // Tenant as a tag + metadata field — never a Langfuse userId.
    tags: [`tenant:${event.tenantId}`],
    metadata: { tenantId: event.tenantId, taskType: event.taskType },
  };
}

function buildGenerationBody(
  event: LLMTraceCompletionEvent,
  captureContent: boolean,
): LangfuseGenerationBody {
  const body: LangfuseGenerationBody = {
    name: event.taskType,
    model: event.servedModel,
    startTime: event.startedAt,
    endTime: new Date(event.startedAt.getTime() + event.latencyMs),
    level: event.error === undefined ? 'DEFAULT' : 'ERROR',
    metadata: {
      tenantId: event.tenantId,
      correlationId: event.correlationId,
      taskType: event.taskType,
      resolvedModel: event.resolvedModel,
      servedModel: event.servedModel,
      provider: event.provider,
      providerPath: event.providerPath,
      fallbackStage: event.fallbackStage,
      cached: event.cached,
      degraded: event.degraded,
      promptVersionId: event.promptVersionId,
      latencyMs: event.latencyMs,
      costMicroCents: event.costMicroCents,
      ...(event.error !== undefined ? { error: event.error } : {}),
    },
  };
  if (event.error !== undefined) body.statusMessage = event.error;
  if (event.promptVersionId) body.version = event.promptVersionId;
  if (event.tokenUsage) {
    body.usageDetails = {
      input: event.tokenUsage.input,
      output: event.tokenUsage.output,
      total: event.tokenUsage.total,
    };
  }
  if (typeof event.costMicroCents === 'number') {
    body.costDetails = { total: microCentsToUsd(event.costMicroCents) };
  }
  if (captureContent) {
    body.input = redactContentForExport(event.input);
    if (event.output !== undefined) body.output = redactTextForExport(event.output);
  }
  return body;
}

export interface LangfuseTraceExporterOptions {
  client: LangfuseClientLike;
  baseUrl: string;
  captureContent: boolean;
  logger?: LLMGatewayLogger;
}

export class LangfuseTraceExporter implements LLMTraceExporter {
  readonly baseUrl: string;
  readonly captureContent: boolean;
  private readonly client: LangfuseClientLike;
  private readonly logger?: LLMGatewayLogger;

  constructor(opts: LangfuseTraceExporterOptions) {
    this.client = opts.client;
    this.baseUrl = opts.baseUrl;
    this.captureContent = opts.captureContent;
    this.logger = opts.logger;
  }

  recordCompletion(event: LLMTraceCompletionEvent): void {
    const trace = this.client.trace(buildTraceBody(event));
    trace.generation(buildGenerationBody(event, this.captureContent));
  }

  /** Shutdown-time drain: flushes the SDK queue and stops its timers. */
  async flush(): Promise<void> {
    try {
      await this.client.shutdownAsync();
    } catch (err) {
      this.logger?.error('LLM trace export flush failed (best-effort)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export type LangfuseTraceConfig = Pick<
  AppConfig,
  'LANGFUSE_PUBLIC_KEY' | 'LANGFUSE_SECRET_KEY' | 'LANGFUSE_BASE_URL' | 'LANGFUSE_CAPTURE_CONTENT'
>;

/**
 * Both keys present → Langfuse exporter against the configured base URL;
 * either absent → noop (zero network). `deps.createClient` exists for tests.
 */
export function createTraceExporterFromConfig(
  config: LangfuseTraceConfig,
  logger?: LLMGatewayLogger,
  deps: { createClient?: (opts: LangfuseClientOptions) => LangfuseClientLike | null } = {},
): LLMTraceExporter {
  const publicKey = config.LANGFUSE_PUBLIC_KEY;
  const secretKey = config.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return new NoopTraceExporter();

  const baseUrl = config.LANGFUSE_BASE_URL;
  const client = (deps.createClient ?? createLangfuseClient)({ publicKey, secretKey, baseUrl });
  if (!client) {
    logger?.error(
      'LANGFUSE_* keys are set but the langfuse module is not installed — LLM trace export disabled',
      { baseUrl },
    );
    return new NoopTraceExporter();
  }

  return new LangfuseTraceExporter({
    client,
    baseUrl,
    captureContent: config.LANGFUSE_CAPTURE_CONTENT,
    logger,
  });
}
