/**
 * Retry policy for the LLM gateway.
 *
 * Bounded, idempotent-safe retries with exponential backoff + full jitter.
 * Retries skip when the remaining deadline is < MIN_RETRY_BUDGET_MS to avoid
 * extending a doomed request beyond its caller-visible budget.
 *
 *   error class           retry?
 *   --------------------  ------
 *   transient             yes (max 2 non-streaming, 1 stream-init)
 *   timeout               yes
 *   rate_limited          yes (honor Retry-After if present)
 *   permanent             no
 */
import { gatewayRetryAttemptsTotal } from '../../monitoring/metrics';
import { MIN_RETRY_BUDGET_MS, isDeadlineExceeded, type DeadlineContext } from './deadline';

export type ErrorClass = 'transient' | 'permanent' | 'timeout' | 'rate_limited';

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Backoff base in ms; default 100. */
  baseDelayMs: number;
  /** Backoff cap in ms; default 1500. */
  capDelayMs: number;
  /** Streaming initiation: 1 retry max. After first token: 0 retries. */
  mode: 'sync' | 'stream-init' | 'in-stream';
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  capDelayMs: 1500,
  mode: 'sync',
};

export const STREAM_INIT_RETRY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 100,
  capDelayMs: 1500,
  mode: 'stream-init',
};

export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  capDelayMs: 0,
  mode: 'in-stream',
};

/**
 * VOX-32: thrown by a provider when a request completes but the model returns
 * structurally empty / malformed output (no content). This is a classic
 * transient LLM hiccup, not a permanent failure, so `classifyError` maps it to
 * 'transient' and `runWithRetry` retries it within the remaining deadline.
 *
 * KNOWN LIMITATION (separately tracked): with a single configured provider the
 * failover list (`fallbackProviders`) is always empty, so in-deadline retry is
 * the ONLY recovery path for this class — there is no cross-provider failover
 * yet. Adding a second real provider is purely additive (see
 * compose-resilience.ts single-provider note).
 */
export class EmptyProviderResponseError extends Error {
  readonly code = 'PROVIDER_EMPTY_RESPONSE';
  constructor(message: string) {
    super(message);
    this.name = 'EmptyProviderResponseError';
  }
}

export function classifyError(err: unknown): ErrorClass {
  if (isDeadlineExceeded(err)) return 'timeout';
  if (err instanceof Error) {
    // VOX-32: empty/malformed provider output → transient (retryable). It
    // carries no HTTP status, so without this it would fall through to
    // 'permanent' and never be retried.
    if ((err as { code?: string }).code === 'PROVIDER_EMPTY_RESPONSE') return 'transient';
    const msg = err.message.toLowerCase();
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;

    if (status === 429) return 'rate_limited';
    if (typeof status === 'number') {
      if (status >= 500) return 'transient';
      if (status >= 400) return 'permanent';
    }

    // node-fetch / undici / openai SDK transient signals
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('econnrefused') ||
      msg.includes('eai_again') ||
      msg.includes('aborted') ||
      msg.includes('timeout')
    ) {
      return 'transient';
    }
  }
  return 'permanent';
}

export function isRetryable(
  errClass: ErrorClass,
  attempt: number,
  policy: RetryPolicy,
  remainingDeadlineMs: number,
): boolean {
  if (errClass === 'permanent') return false;
  if (attempt >= policy.maxAttempts) return false;
  if (remainingDeadlineMs < MIN_RETRY_BUDGET_MS) return false;
  return true;
}

/** Full-jitter exponential backoff: random(0, min(cap, base * 2^attempt)). */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  rng: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capDelayMs, policy.baseDelayMs * Math.pow(2, attempt));
  if (ceiling <= 0) return 0;
  return Math.floor(rng() * ceiling);
}

export interface RetryAttemptInfo {
  attempt: number;
  errClass: ErrorClass;
  delayMs: number;
}

export interface RunWithRetryOptions {
  policy?: RetryPolicy;
  deadline?: DeadlineContext;
  /** Provider name for metrics; falls back to "unknown". */
  provider?: string;
  /** Task type for metrics; falls back to "unknown". */
  taskType?: string;
  /** Hook called before each backoff sleep — useful for tests. */
  onAttempt?: (info: RetryAttemptInfo) => void;
  /** Optional rng override for deterministic testing. */
  rng?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

export async function runWithRetry<T>(
  op: (attempt: number) => Promise<T>,
  opts: RunWithRetryOptions = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? defaultSleep;
  const provider = opts.provider ?? 'unknown';
  const taskType = opts.taskType ?? 'unknown';

  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    if (opts.deadline?.isExpired()) {
      throw lastErr ?? new Error('Deadline exceeded before attempt');
    }
    try {
      return await op(attempt);
    } catch (err) {
      lastErr = err;
      const errClass = classifyError(err);
      const remaining = opts.deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
      const next = attempt + 1;
      if (!isRetryable(errClass, next, policy, remaining)) {
        throw err;
      }
      const delay = Math.min(
        backoffDelayMs(attempt, policy, opts.rng),
        Math.max(0, remaining - 50),
      );
      gatewayRetryAttemptsTotal.inc({ provider, taskType, outcome: errClass });
      opts.onAttempt?.({ attempt: next, errClass, delayMs: delay });
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
}
