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
 *   rate_limited          yes — waits the provider's Retry-After when (and
 *                         ONLY when) that wait plus a minimum viable attempt
 *                         still fits the remaining deadline; otherwise fails
 *                         fast with the typed rate-limit error.
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

/**
 * Thrown by a provider adapter when the upstream answers HTTP 429.
 *
 * A 429 is a THROTTLE, not an outage. The provider is healthy, it is up, and
 * it usually tells us *exactly* when to come back (`retry-after` /
 * `retry-after-ms` / `x-ratelimit-reset-*`). Flattening that into a generic
 * failure is what produced the 2026-07-27 incident message
 * "All providers failed. Last error: Request was aborted." for what was really
 * "the org's daily request quota is spent; try again in 8.64s".
 *
 * The shape deliberately mirrors `NormalizedProviderFailure` in
 * `notifications/twilio-delivery-provider.ts` (status + provider code +
 * retry-after), so both provider families classify throttles the same way.
 *
 * `status = 429` is what makes the existing classifiers agree with this type
 * without special-casing it: `classifyError` → 'rate_limited',
 * `isPermanentClientError` (breaker) → false, `isFailoverEligible` → true.
 */
export class ProviderRateLimitError extends Error {
  readonly code = 'PROVIDER_RATE_LIMITED';
  readonly status = 429;
  /** Parsed wait hint in ms; undefined when the provider sent no usable header. */
  readonly retryAfterMs?: number;
  readonly providerName: string;
  /** The provider's own error `type` (e.g. OpenAI's `rate_limit_exceeded`). */
  readonly providerErrorType?: string;
  /** The provider's own error `code` (e.g. OpenAI's `requests`). */
  readonly providerErrorCode?: string;
  /** The provider's verbatim message — never flattened away. */
  readonly providerMessage: string;

  constructor(opts: {
    providerName: string;
    providerMessage: string;
    retryAfterMs?: number;
    providerErrorType?: string;
    providerErrorCode?: string;
  }) {
    super(opts.providerMessage);
    this.name = 'ProviderRateLimitError';
    this.providerName = opts.providerName;
    this.providerMessage = opts.providerMessage;
    this.retryAfterMs = opts.retryAfterMs;
    this.providerErrorType = opts.providerErrorType;
    this.providerErrorCode = opts.providerErrorCode;
  }
}

/**
 * True for any provider throttle — our typed error, or a raw SDK/HTTP error
 * that carries status 429 (so the check keeps working for providers whose
 * adapter has not been normalized yet).
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { code?: unknown }).code === 'PROVIDER_RATE_LIMITED') return true;
  const status =
    (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return status === 429;
}

/** Read a non-negative `retryAfterMs` hint off an error, if it carries one. */
export function retryAfterMsFromError(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const raw = (err as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  return undefined;
}

/**
 * Extra randomness added on top of an honored `retry-after` wait.
 *
 * Every replica that got throttled receives the SAME retry-after value, so
 * obeying it to the millisecond re-synchronises the whole fleet into one
 * thundering herd at the reset instant. Backoff already uses full jitter
 * (`backoffDelayMs`); this is the equivalent for the retry-after path.
 */
export const RETRY_AFTER_JITTER_MS = 250;

export function classifyError(err: unknown): ErrorClass {
  // Checked BEFORE isDeadlineExceeded: a throttle carries the provider's own
  // verbatim message, and that message is free to contain the words "timeout"
  // or "deadline" (OpenAI's RPD text does not, but no adapter should depend on
  // that). An explicit 429 always outranks message sniffing.
  if (isRateLimitError(err)) return 'rate_limited';
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
  /** True when `delayMs` came from the provider's retry-after, not backoff. */
  honoredRetryAfter?: boolean;
}

/**
 * Decide what to do about a `rate_limited` error that is otherwise retryable.
 *
 * Exported for direct unit testing — this is the rule that stops a throttle
 * from eating the caller's whole budget.
 *
 *  - No usable retry-after → fall back to jittered exponential backoff.
 *  - retry-after that leaves room for a real attempt → wait it out once.
 *  - retry-after that does NOT → fail fast. Sleeping until the wall only to
 *    hit the same wall costs the caller their entire deadline and returns the
 *    identical error; worse, the in-flight request keeps holding its
 *    per-tenant concurrency lease the whole time, which is what turned a
 *    throttle into `Per-tenant concurrency cap exceeded` in production.
 */
export function planRateLimitWait(
  retryAfterMs: number | undefined,
  remainingDeadlineMs: number,
  rng: () => number = Math.random,
): { action: 'wait'; delayMs: number } | { action: 'fail-fast' } | { action: 'backoff' } {
  if (retryAfterMs === undefined) return { action: 'backoff' };
  const delayMs = retryAfterMs + Math.floor(rng() * RETRY_AFTER_JITTER_MS);
  if (delayMs + MIN_RETRY_BUDGET_MS > remainingDeadlineMs) return { action: 'fail-fast' };
  return { action: 'wait', delayMs };
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

      let delay: number;
      let honoredRetryAfter = false;
      if (errClass === 'rate_limited') {
        const plan = planRateLimitWait(retryAfterMsFromError(err), remaining, opts.rng);
        // Unsatisfiable throttle: surface the typed rate-limit error NOW
        // rather than burning the remaining budget to arrive at the same wall.
        if (plan.action === 'fail-fast') throw err;
        if (plan.action === 'wait') {
          delay = plan.delayMs;
          honoredRetryAfter = true;
        } else {
          // Throttled but no usable retry-after — jittered backoff, same as
          // any other transient class.
          delay = Math.min(
            backoffDelayMs(attempt, policy, opts.rng),
            Math.max(0, remaining - 50),
          );
        }
      } else {
        delay = Math.min(
          backoffDelayMs(attempt, policy, opts.rng),
          Math.max(0, remaining - 50),
        );
      }

      gatewayRetryAttemptsTotal.inc({ provider, taskType, outcome: errClass });
      opts.onAttempt?.({ attempt: next, errClass, delayMs: delay, honoredRetryAfter });
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastErr;
}
