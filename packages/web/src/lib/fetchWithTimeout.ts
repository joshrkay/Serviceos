/**
 * #1397 — a hung API request used to spin forever (no error even at 60s).
 * Both API clients (`useApiClient` and `apiFetch`) route through this
 * helper so every request is aborted after `API_REQUEST_TIMEOUT_MS`.
 *
 * A timeout rejects with `ApiTimeoutError`, deliberately NOT an
 * `AbortError`: callers treat AbortError as a deliberate cancellation
 * (sign-out, unmount) and swallow it, whereas a timeout must reach the
 * caller's existing error UI (ErrorState + Retry, mutation toasts). A
 * caller's own `init.signal` abort still rejects with the original
 * AbortError.
 */

export const API_REQUEST_TIMEOUT_MS = 30_000;

export const API_TIMEOUT_MESSAGE =
  'The request took too long. Check your connection and try again.';

export class ApiTimeoutError extends Error {
  constructor(message: string = API_TIMEOUT_MESSAGE) {
    super(message);
    this.name = 'ApiTimeoutError';
  }
}

function isUploadBody(body: RequestInit['body']): boolean {
  if (body == null || typeof body === 'string') return false;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return false;
  return true;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = API_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // File uploads (FormData / Blob / binary bodies) legitimately take longer
  // than the deadline on a slow mobile link — never cut them off.
  if (isUploadBody(init.body)) return fetch(input, init);

  const controller = new AbortController();
  const callerSignal = init.signal ?? undefined;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new ApiTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
