/**
 * Bounded outbound HTTP for provider calls (Stripe, Google, Clerk, Twilio).
 *
 * The platform fetch has no overall deadline (undici waits up to 300 s for
 * headers). Most `/api` handlers run inside a request transaction that pins a
 * pooled connection, so a provider that stops answering holds that connection
 * until the 60 s idle-in-transaction guard kills it — and ~20 such requests
 * exhaust the pool for everyone.
 *
 * `timedFetch(ms)` returns a fetch that aborts after `ms` (the deadline also
 * covers reading the body). A timeout rejects exactly where a network failure
 * does — from the fetch call, with a DOMException named "TimeoutError", the
 * same shape `AbortSignal.timeout` produces — so callers keep their existing
 * failure handling. A caller-supplied `signal` still aborts the request.
 *
 * The deadline is armed with `setTimeout` (unref'd) rather than
 * `AbortSignal.timeout` so tests can drive it with fake timers. Services use
 * it as their default when no fetch is injected; `baseFetch` defaults to the
 * global fetch looked up per call.
 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 10_000;

export function timedFetch(
  timeoutMs: number = DEFAULT_OUTBOUND_TIMEOUT_MS,
  baseFetch?: typeof fetch,
): typeof fetch {
  return (input, init) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
    return (baseFetch ?? globalThis.fetch)(input, { ...init, signal });
  };
}
