/**
 * Auth-aware fetch for the mobile app — the RN port of the web client
 * (`packages/web/src/lib/apiClient.ts` + `utils/api-fetch.ts`).
 *
 * Same contract as web, so the backend's RLS/auth guarantees hold identically:
 *   1. Public, view-token-gated paths never receive an Authorization header.
 *   2. Authenticated `/api/` paths require a fresh Clerk token; a null token
 *      (mid sign-out) cancels the request with an AbortError — we MUST NOT
 *      send an unauthenticated request to a protected route.
 *   3. On a 401 from an authenticated path, retry ONCE with a force-refreshed
 *      token before invoking `onUnauthenticated` (the hook routes to sign-in).
 *   4. Non-`/api/` URLs get a best-effort Bearer if a token is handy, no retry.
 *
 * RN differences from web: requests are not same-origin, so paths are resolved
 * against `baseUrl`; there is no `window.location`, so re-auth is delegated to
 * an injected `onUnauthenticated` callback. This module imports neither Clerk
 * nor React Native — it is a pure factory, unit-tested with a mocked fetch.
 */

/**
 * Path prefixes that must NEVER receive an Authorization header — gated by
 * view-tokens in the URL, not the session JWT. Keep in sync with the web list
 * (`packages/web/src/lib/apiClient.ts`).
 */
export const PUBLIC_API_PREFIXES = [
  '/api/public-payments/',
  '/api/public-estimates/',
  '/api/public/',
  '/public/',
] as const;

/** True if `path` targets a public, view-token-gated endpoint. */
export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => path.startsWith(p));
}

/** True if `path` should receive the Authorization header. */
export function shouldInjectAuth(path: string): boolean {
  return path.startsWith('/api/') && !isPublicApiPath(path);
}

/**
 * Error used when a request is cancelled because no auth token was available.
 * RN/Hermes has no reliable `DOMException`, so we tag a plain Error;
 * callers assert on `.name === 'AbortError'`.
 */
export function makeUnauthenticatedAbort(): Error {
  const err = new Error('Unauthenticated request cancelled');
  err.name = 'AbortError';
  return err;
}

/**
 * Error a request rejects with when it exceeds {@link DEFAULT_TIMEOUT_MS}.
 * Tagged `name === 'TimeoutError'` (distinct from the sign-out `AbortError`) so
 * `decodeError` classifies it as `timeout` rather than the swallowed sign-out.
 */
export function makeTimeoutError(): Error {
  const err = new Error('Request timed out');
  err.name = 'TimeoutError';
  return err;
}

/** Default per-request timeout — a hung socket rejects instead of hanging the UI. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type TokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string | null>;

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ApiFetchDeps {
  /** Absolute API base, e.g. https://api.example.com (no trailing slash). */
  baseUrl: string;
  /** Resolves a fresh JWT; `forceRefresh` bypasses Clerk's cache for the 401 retry. */
  getToken: TokenGetter;
  /** Called when re-auth is required (after a failed 401 retry). */
  onUnauthenticated?: () => void;
  /** Per-request timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. 0 disables it. */
  timeoutMs?: number;
}

function buildHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) headers[key] = value;
  } else if (init.headers) {
    Object.assign(headers, init.headers as Record<string, string>);
  }
  // Default Content-Type only for string bodies — fetch() infers it for
  // FormData/Blob/URLSearchParams, and forcing JSON onto those corrupts them.
  if (typeof init.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/** Build a fetch-shaped client with auth + 401-retry baked in. */
export function createApiFetch(deps: ApiFetchDeps): ApiFetch {
  const { baseUrl, getToken, onUnauthenticated } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const toUrl = (path: string): string =>
    path.startsWith('http') ? path : `${baseUrl}${path}`;

  // Wrap fetch with an AbortController timeout. A real abort surfaces as an
  // AbortError DOMException; we translate the *timeout* abort to a distinct
  // TimeoutError so it isn't mistaken for the sign-out AbortError and so
  // `decodeError` can classify it as `timeout`.
  const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
    if (timeoutMs <= 0) return fetch(url, init);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw makeTimeoutError();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = buildHeaders(init);
    const url = toUrl(path);

    if (isPublicApiPath(path)) {
      return fetchWithTimeout(url, { ...init, headers });
    }

    if (!shouldInjectAuth(path)) {
      try {
        const token = await getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch {
        // best-effort — don't block a public-ish call on token errors
      }
      return fetchWithTimeout(url, { ...init, headers });
    }

    // Authenticated /api/ path — strictly require a token.
    const token = await getToken();
    if (!token) throw makeUnauthenticatedAbort();
    headers['Authorization'] = `Bearer ${token}`;

    const response = await fetchWithTimeout(url, { ...init, headers });
    if (response.status !== 401) return response;

    // 401 — one retry with a force-refreshed token before giving up.
    let fresh: string | null = null;
    try {
      fresh = await getToken({ forceRefresh: true });
    } catch {
      fresh = null;
    }
    if (fresh) {
      const retry = await fetchWithTimeout(url, {
        ...init,
        headers: { ...headers, Authorization: `Bearer ${fresh}` },
      });
      if (retry.status !== 401) return retry;
    }
    onUnauthenticated?.();
    throw new Error('Unauthorized — re-authentication required');
  };
}
