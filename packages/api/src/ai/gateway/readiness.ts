/**
 * Completion-level AI readiness probe.
 *
 * `/api/health/ai` only lists circuit-breaker state — a closed breaker with
 * a bad key or model/provider mismatch still looks healthy. This helper
 * issues one cheap `classify_intent` completion so ops can see the real
 * failure mode without running the full operator top-50 probe.
 *
 * Never logs prompt/PII. Results are cached briefly to avoid hammering the
 * provider from scrape loops.
 */

import type { LLMGateway, LLMRequest } from './gateway';
import { SYSTEM_TENANT_ID } from './gateway';
import { resolveClassifyIntentDeadlineMs } from '../../config/ai-routing';

export interface AiCompletionProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Stable machine code for dashboards — never a raw provider dump. */
  errorCode?: string;
  model?: string;
  checkedAt: string;
  cached: boolean;
}

export interface ProbeAiCompletionOptions {
  /** Hard timeout for the probe complete() call. Default: classify deadline (min 10s). */
  timeoutMs?: number;
  /** Cache TTL. Default 30_000ms. */
  cacheTtlMs?: number;
  /** Override clock (tests). */
  now?: () => number;
}

interface CacheEntry {
  result: AiCompletionProbeResult;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Test-only: clear the in-process probe cache. */
export function clearAiCompletionProbeCache(): void {
  cache = null;
}

function parsePositiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Probe budget must not undercut live `classify_intent` traffic. A 5s race
 * against a 12s classify deadline was aborting mid-flight and opening the
 * circuit breaker (`Request was aborted.`) during health scrapes.
 */
export function resolveCompletionProbeTimeoutMs(): number {
  const fromEnv = parsePositiveIntEnv(process.env.AI_COMPLETION_PROBE_TIMEOUT_MS);
  if (fromEnv !== undefined) return fromEnv;
  return Math.max(resolveClassifyIntentDeadlineMs(), 10_000);
}

function classifyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('deadline') || lower.includes('aborted')) {
    return 'timeout';
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
    return 'auth';
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'rate_limit';
  }
  if (
    lower.includes('model') &&
    (lower.includes('not found') || lower.includes('does not exist') || lower.includes('invalid'))
  ) {
    return 'model_not_found';
  }
  if (lower.includes('vision') || lower.includes('image content')) {
    return 'vision_mismatch';
  }
  return 'provider_error';
}

/**
 * Run (or return cached) a tiny classify_intent completion against the live
 * gateway. Uses SYSTEM_TENANT_ID — readiness is a platform check, not a
 * tenant workflow. Caller should keep scrape intervals ≥ cache TTL.
 */
export async function probeAiCompletion(
  gateway: Pick<LLMGateway, 'complete'>,
  opts: ProbeAiCompletionOptions = {},
): Promise<AiCompletionProbeResult> {
  const timeoutMs = opts.timeoutMs ?? resolveCompletionProbeTimeoutMs();
  const cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  const now = opts.now ?? Date.now;

  const t = now();
  if (cache && cache.expiresAt > t) {
    return { ...cache.result, cached: true };
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error('AI completion probe timeout'));
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const request: LLMRequest = {
    taskType: 'classify_intent',
    tenantId: SYSTEM_TENANT_ID,
    maxTokens: 16,
    temperature: 0,
    deadlineMs: timeoutMs,
    signal: controller.signal,
    messages: [{ role: 'user', content: 'ping' }],
  };

  try {
    const response = await gateway.complete(request);
    const latencyMs = Math.max(0, now() - started);
    const result: AiCompletionProbeResult = {
      ok: true,
      latencyMs,
      model: response.model,
      checkedAt: new Date(now()).toISOString(),
      cached: false,
    };
    cache = { result, expiresAt: now() + cacheTtlMs };
    return result;
  } catch (err) {
    const latencyMs = Math.max(0, now() - started);
    const result: AiCompletionProbeResult = {
      ok: false,
      latencyMs,
      errorCode: classifyError(err),
      checkedAt: new Date(now()).toISOString(),
      cached: false,
    };
    cache = { result, expiresAt: now() + cacheTtlMs };
    return result;
  } finally {
    clearTimeout(timer);
  }
}
