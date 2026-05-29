/**
 * Auth-aware fetch wrapper for non-hook callsites.
 *
 * Behaviorally aligned with the hook-based `useApiClient` (see
 * `lib/apiClient.ts`) so any of the ~80 callers of `apiFetch` get the same
 * security and reliability guarantees:
 *
 *   1. Public API paths (view-token-gated routes — see PUBLIC_API_PREFIXES)
 *      never receive an Authorization header.
 *   2. Authenticated paths require a fresh token. If `getToken()` returns
 *      null (sign-out transition, no active session), the request is
 *      cancelled by throwing an AbortError — we MUST NOT send an
 *      unauthenticated request to a protected endpoint.
 *   3. On a 401 response from an authenticated path, retry ONCE with a
 *      forcibly-refreshed token (`getToken({ forceRefresh: true })`); if
 *      that also returns 401, redirect to /login (preserving the current
 *      path so the user lands where they were).
 *   4. Public paths (or unauthenticated routes that don't start with
 *      `/api/`) get a passthrough fetch — no auth, no retry, no redirect.
 *
 * This file does NOT depend on Clerk directly. `AuthTokenBridge` wires a
 * Clerk-aware getter via `setTokenGetter` at app startup, and tests can
 * inject their own getter.
 *
 * Pre-fix, `apiFetch` had a much simpler shape: attach Bearer if a token
 * was available, otherwise send the request anyway with no Authorization
 * header. That silently turned every expired-token call into a 401 the
 * caller had to handle by itself, and on public pages without Clerk it
 * was the right behavior — so the helper was effectively two flows
 * smashed together. The shared helpers from `lib/apiClient.ts`
 * disambiguate: `isPublicApiPath` decides per-request whether to attach
 * auth, mirroring the hook variant exactly.
 */

import {
  isPublicApiPath,
  makeUnauthenticatedAbort,
  redirectToLogin,
  shouldInjectAuth,
} from '../lib/apiClient';

/**
 * Token getter — supports the `forceRefresh` option that `useApiClient`
 * uses for its single 401-retry. Returns `null` when no session is active
 * (e.g. mid sign-out); apiFetch then aborts authenticated requests.
 */
export type TokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string | null>;

let getToken: TokenGetter | null = null;

/**
 * Called once from ClerkProvider setup (`AuthTokenBridge`) to wire the
 * token getter. The getter must support `forceRefresh: true` so the
 * 401-retry path can bypass the Clerk client-side cache.
 *
 * Accepts the legacy single-argument form `() => Promise<string | null>`
 * too — that path treats `forceRefresh` as a no-op (best effort).
 */
export function setTokenGetter(
  fn: TokenGetter | (() => Promise<string | null>),
): void {
  getToken = fn.length === 0 ? () => (fn as () => Promise<string | null>)() : (fn as TokenGetter);
}

/** Test/teardown helper — undo `setTokenGetter`. */
export function clearTokenGetter(): void {
  getToken = null;
}

function pathFrom(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname + input.search;
  // Request object — read .url
  try {
    return new URL((input as Request).url, 'http://x').pathname;
  } catch {
    return '';
  }
}

function buildHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) headers[key] = value;
  } else if (init.headers) {
    Object.assign(headers, init.headers);
  }
  // Set default Content-Type only for string bodies. fetch() already
  // infers it for FormData / URLSearchParams / Blob / ArrayBuffer, and
  // forcing JSON onto those would corrupt the request.
  if (typeof init.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  } else if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string' && !headers['Content-Type']) {
    // Legacy behavior: caller-supplied non-string, non-FormData bodies
    // historically defaulted to JSON via the previous apiFetch
    // implementation. Preserve that to avoid surprising existing
    // callers, but only when no Content-Type was already set.
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const path = pathFrom(input);
  const headers = buildHeaders(init);

  // Public, view-token-gated paths — pass through with no Authorization
  // and no 401 redirect. This matches `useApiClient`'s isPublicApiPath
  // branch.
  if (isPublicApiPath(path)) {
    return fetch(input, { ...init, headers });
  }

  // Non-`/api/` paths (assets, third-party hosts, etc.) — just attach
  // a token opportunistically if we happen to have one, like the
  // pre-fix behavior. No 401 retry or redirect for these.
  if (!shouldInjectAuth(path)) {
    if (getToken) {
      try {
        const token = await getToken();
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch {
        // best-effort — don't block a public-ish call on token errors
      }
    }
    return fetch(input, { ...init, headers });
  }

  // Authenticated /api/ path. If a token getter is wired (production /
  // any code path that has booted ClerkProvider → AuthTokenBridge), we
  // strictly require a token: a null token means sign-out is in
  // progress and we MUST NOT send an unauthenticated request to a
  // protected endpoint, so the request is cancelled with AbortError.
  //
  // If no getter is wired at all — pre-bridge boot, unit tests that
  // mock `fetch` without setting up Clerk — fall through to
  // passthrough fetch. This preserves the legacy `apiFetch` behavior
  // for tests and keeps the upgrade safe to ship without touching every
  // existing test mock. The strict-abort path is what protects the
  // real app at runtime, where AuthTokenBridge is always mounted.
  if (getToken) {
    const token = await getToken();
    if (!token) {
      throw makeUnauthenticatedAbort();
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(input, { ...init, headers });

  if (response.status !== 401) return response;

  // 401 — single retry with a force-refreshed token before giving up.
  // Covers the normal token-expiry case without bouncing the user.
  let fresh: string | null = null;
  try {
    fresh = await getToken({ forceRefresh: true });
  } catch {
    fresh = null;
  }
  if (fresh) {
    const retryHeaders: Record<string, string> = {
      ...headers,
      Authorization: `Bearer ${fresh}`,
    };
    const retry = await fetch(input, { ...init, headers: retryHeaders });
    if (retry.status !== 401) return retry;
  }
  // Still unauthorized after a refresh — bounce to login.
  redirectToLogin();
  throw new Error('Unauthorized — redirecting to login');
}
