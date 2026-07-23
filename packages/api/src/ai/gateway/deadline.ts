/**
 * Deadline propagation for the LLM gateway.
 *
 * A `DeadlineContext` carries a monotonic absolute deadline + an AbortController.
 * The resilience layer (retry, breaker, provider call) reads remaining budget
 * to decide whether to retry, wait, or fail fast.
 *
 * Stage budgets (informative, used by callers that want to short-circuit):
 *   T_route       100 ms
 *   T_connect     500 ms
 *   T_provider    dynamic per model tier (caller supplies)
 *   T_postprocess 300 ms
 *   T_total       8 s sync / 25 s streaming (caller supplies)
 *
 * The minimum viable retry budget is 700ms — see retry.ts.
 */

export const MIN_RETRY_BUDGET_MS = 700;

export const STAGE_BUDGETS = {
  route: 100,
  connect: 500,
  postprocess: 300,
  // VOX-34: last-resort fallback only. gateway.complete() now sets
  // request.deadlineMs from the resolved model tier (config/ai-routing.ts
  // resolveTierDeadlineMs — lightweight ~1.5s / standard ~4s / complex ~8s),
  // so ProviderRetryDeadlineWrapper reaches this default only for callers that
  // bypass tier resolution.
  defaultTotal: 8_000,
  defaultStreamingTotal: 25_000,
} as const;

export interface DeadlineContext {
  /** Monotonic ms when the deadline elapses (process.hrtime-derived). */
  deadlineAtMs: number;
  /** Caller-visible AbortSignal — providers must honor it. */
  signal: AbortSignal;
  /** Abort the controller (idempotent). */
  abort: (reason?: unknown) => void;
  /** ms remaining; never negative. */
  remainingMs(): number;
  /** True when the deadline has elapsed or the controller has been aborted. */
  isExpired(): boolean;
}

function nowMs(): number {
  // hrtime is monotonic; Date.now() is wall clock and can jump.
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1_000_000;
}

export function createDeadlineContext(totalMs: number): DeadlineContext {
  const controller = new AbortController();
  const deadlineAtMs = nowMs() + Math.max(0, totalMs);

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new DeadlineExceededError(totalMs));
    }
  }, Math.max(0, totalMs));
  // Don't keep the event loop alive solely for a deadline timer.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    deadlineAtMs,
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
      clearTimeout(timer);
    },
    remainingMs: () => Math.max(0, deadlineAtMs - nowMs()),
    isExpired: () =>
      controller.signal.aborted || nowMs() >= deadlineAtMs,
  };
}

/**
 * Adopt an externally supplied signal: returns a context that fires when the
 * caller signal aborts OR when the local timer elapses (whichever first).
 *
 * If the local context aborts first, we proactively detach the listener
 * from the parent signal so a long-lived parent (e.g. a request-scoped
 * AbortController) doesn't retain references to every short-lived child
 * deadline that ever attached to it.
 */
export function adoptDeadline(
  totalMs: number,
  parentSignal?: AbortSignal,
): DeadlineContext {
  const ctx = createDeadlineContext(totalMs);
  if (parentSignal) {
    if (parentSignal.aborted) {
      ctx.abort(parentSignal.reason);
    } else {
      const onAbort = () => ctx.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', onAbort, { once: true });
      // If the local ctx aborts first, remove the listener from the
      // parent so the closure (and the ctx it captures) can be GC'd.
      ctx.signal.addEventListener(
        'abort',
        () => parentSignal.removeEventListener('abort', onAbort),
        { once: true },
      );
    }
  }
  return ctx;
}

export class DeadlineExceededError extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  readonly totalMs: number;
  constructor(totalMs: number) {
    super(`Deadline exceeded after ${totalMs}ms`);
    this.totalMs = totalMs;
    this.name = 'DeadlineExceededError';
  }
}

/**
 * True when the error is our typed deadline, or an AbortError / aborted
 * fetch that the OpenAI SDK surfaces as `Request was aborted.` after the
 * resilience layer's AbortSignal fires. Without the message/name check,
 * those aborts were audited as `provider` failures and tripped the wrong
 * repair path ("trouble hearing you" on a text classify).
 */
export function isDeadlineExceeded(err: unknown): boolean {
  if (err instanceof DeadlineExceededError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'DEADLINE_EXCEEDED') return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const lower = err.message.toLowerCase();
  return lower.includes('aborted') || lower.includes('deadline') || lower.includes('timeout');
}
