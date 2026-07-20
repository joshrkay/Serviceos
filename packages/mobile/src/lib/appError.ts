/**
 * Typed decoding of API failures for the mobile read paths.
 *
 * The backend returns a structured error body — `{ error: CODE, message,
 * details? }` (see `packages/api/src/shared/errors.ts` `toErrorResponse`) — but
 * the read hooks historically reduced any non-2xx to the opaque string
 * `HTTP <status>`, discarding the server's human message and the typed code.
 * `decodeError` recovers that: it maps the backend CODE to a stable `kind`,
 * surfaces the server's `message` when present (else a typed fallback), and
 * classifies transport-level failures (offline / timeout) that never reach the
 * server. The sign-out `AbortError` (`apiFetch.makeUnauthenticatedAbort`) is
 * passed through untouched so callers keep swallowing it.
 *
 * This module is pure except for reading a `Response` body; it knows nothing of
 * React/RN and is unit-tested directly.
 */

/** Discriminator for how a request failed — drives caller copy/handling. */
export type AppErrorKind =
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'conflict'
  | 'validation'
  | 'server'
  | 'unknown';

export interface AppError {
  kind: AppErrorKind;
  /** Backend human message when present, else a typed fallback. */
  message: string;
  /** Structured backend `details` (e.g. Zod field errors), passed through verbatim. */
  details?: Record<string, unknown>;
}

/** Backend `error` CODE → AppError kind. Keep in sync with `errors.ts`. */
const CODE_TO_KIND: Record<string, AppErrorKind> = {
  VALIDATION_ERROR: 'validation',
  NOT_FOUND: 'notFound',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  INTERNAL_ERROR: 'server',
};

/** Last-resort copy when the backend gives us nothing usable. */
const FALLBACK_MESSAGE: Record<AppErrorKind, string> = {
  offline: 'You appear to be offline. Check your connection and try again.',
  timeout: 'The request timed out. Please try again.',
  unauthorized: 'Your session has expired. Please sign in again.',
  forbidden: "You don't have access to this.",
  notFound: 'This could not be found.',
  conflict: 'This was already changed. Refresh and try again.',
  validation: 'Some details were invalid. Please check and try again.',
  server: 'Something went wrong on our end. Please try again.',
  unknown: 'Something went wrong. Please try again.',
};

/** Map an HTTP status to a kind when there is no structured `error` code. */
function statusToKind(status: number): AppErrorKind {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'notFound';
    case 409:
      return 'conflict';
    case 400:
    case 422:
      return 'validation';
    default:
      return status >= 500 ? 'server' : 'unknown';
  }
}

/** A non-2xx HTTP failure: a real `Response` or the RN duck-typed equivalent. */
interface ResponseLike {
  status: number;
  json: () => Promise<unknown>;
}

/**
 * True for a response-like value. We don't rely on `instanceof Response`:
 * RN's fetch may hand back a polyfilled Response, and the hooks are tested with
 * a duck-typed `{ ok, status, json }` — both must decode the same way.
 */
function isResponseLike(input: unknown): input is ResponseLike {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as ResponseLike).status === 'number' &&
    typeof (input as ResponseLike).json === 'function'
  );
}

function appError(kind: AppErrorKind, message?: string, details?: Record<string, unknown>): AppError {
  return {
    kind,
    message: message && message.trim() ? message : FALLBACK_MESSAGE[kind],
    ...(details ? { details } : {}),
  };
}

/** True for the RN/Hermes "no connectivity" fetch rejection. */
function isNetworkError(err: unknown): boolean {
  return err instanceof Error && /network request failed/i.test(err.message);
}

/** True for an AbortController timeout (see `apiFetch` timeout wiring). */
function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** True for the sign-out abort (`makeUnauthenticatedAbort`) — never reclassified. */
function isSignOutAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** True for the exhausted-401-retry throw (`makeTerminalAuthError`). */
function isTerminalAuth(err: unknown): boolean {
  return err instanceof Error && err.name === 'TerminalAuthError';
}

async function decodeResponse(res: ResponseLike): Promise<AppError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Non-JSON / empty body (e.g. a proxy 502): fall back to the status alone.
    return appError(statusToKind(res.status));
  }
  if (!body || typeof body !== 'object') {
    return appError(statusToKind(res.status));
  }
  const { error: code, message, details } = body as {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const kind =
    typeof code === 'string' && code in CODE_TO_KIND
      ? CODE_TO_KIND[code]
      : statusToKind(res.status);
  return appError(
    kind,
    typeof message === 'string' ? message : undefined,
    details && typeof details === 'object' ? (details as Record<string, unknown>) : undefined,
  );
}

/**
 * Decode an API failure into a typed `AppError`.
 *
 * - A non-2xx `Response`: parse the backend `{ error, message, details }` body
 *   and map CODE→kind (synchronous-looking but returns a Promise).
 * - A thrown `Network request failed`: `offline`.
 * - An AbortController timeout (`TimeoutError`): `timeout`.
 * - The sign-out `AbortError`: re-thrown unchanged so callers keep swallowing it.
 * - Anything else: `unknown`, preserving the thrown message when present.
 */
export function decodeError(input: Response | unknown): Promise<AppError> | AppError {
  if (isResponseLike(input)) return decodeResponse(input);
  if (isSignOutAbort(input)) throw input; // preserve the sign-out abort as-is
  if (isTerminalAuth(input)) return appError('unauthorized');
  if (isTimeoutAbort(input)) return appError('timeout');
  if (isNetworkError(input)) return appError('offline');
  if (input instanceof Error) return appError('unknown', input.message);
  return appError('unknown');
}
