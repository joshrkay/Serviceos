/**
 * Authenticated API client for the React app.
 *
 * Story P0-030 — every authenticated API call originating from a hook must
 * carry a fresh Clerk JWT in the `Authorization: Bearer <token>` header.
 *
 * This module exposes a single React hook, {@link useApiClient}, which
 * returns a fetch-shaped function that:
 *
 *   1. Fetches a fresh token via Clerk's `getToken()` on every call. We
 *      never cache the resolved value — Clerk handles refresh internally.
 *   2. Skips the Authorization header for known public routes (the
 *      customer-facing payment + estimate-approval endpoints, which are
 *      gated by view-tokens, not session JWTs).
 *   3. Cancels the request — by throwing an AbortError — when no token is
 *      available (e.g. mid sign-out). The story explicitly requires we
 *      do NOT send an unauthenticated request in this state.
 *   4. On a 401 response from an authenticated route, retries ONCE with a
 *      forcibly-refreshed token (`getToken({ skipCache: true })`); if the
 *      retry is still 401, redirects the browser to /login.
 *
 * Public-facing pages (`InvoicePaymentPage`, `EstimateApprovalPage`)
 * intentionally do NOT use this client — they call `fetch` (or the
 * existing `apiFetch` wrapper, which no-ops when there is no token)
 * directly with their view-token-gated endpoints.
 */
import { useAuth } from '@clerk/clerk-react'
import { useCallback } from 'react';

/**
 * Path prefixes that must NEVER receive an Authorization header. These
 * endpoints are gated by view-tokens embedded in the URL path, not by the
 * session JWT.
 *
 * Keep this list in sync with the public mounts in
 * `packages/api/src/routes/public-*`.
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
 * Error subclass used when a request was deliberately cancelled because no
 * authentication token was available. Tests assert on `.name === 'AbortError'`.
 */
export function makeUnauthenticatedAbort(): DOMException {
  return new DOMException('Unauthenticated request cancelled', 'AbortError');
}

/**
 * Triggers a redirect to the login page, preserving the current path so the
 * user lands where they were after re-authentication. Extracted so tests can
 * spy on it via `window.location` without depending on react-router. Exported
 * so the non-hook `apiFetch` helper (utils/api-fetch.ts) can reuse the same
 * redirect URL construction.
 */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  // Already on the login page: reloading it would restart every root-mounted
  // fetch and loop /login into itself, so a repeat 401 here is a no-op.
  if (window.location.pathname.startsWith('/login')) return;
  // Preserve the full path — pathname AND query string — so the login page
  // can return the user exactly where they were, not just to the route root.
  // Hash is intentionally excluded: it is client-only and not round-tripped
  // through the server-side login flow.
  const destination = `${window.location.pathname}${window.location.search}`;
  const target = '/login?redirect=' + encodeURIComponent(destination);
  window.location.href = target;
}

/**
 * Sign-out handler wired by AuthTokenBridge. On a persistent 401 the Clerk
 * client session is still valid locally — the server is the one rejecting
 * it — so bouncing to /login just lets LoginPage's isSignedIn check Navigate
 * straight back, refiring every fetch in an unbounded app↔login reload loop
 * (dev-env outage 2026-07-06). Ending the Clerk session before leaving is
 * the only exit that reconciles client and server state.
 */
type SignOutHandler = () => Promise<unknown>;

let signOutHandler: SignOutHandler | null = null;
let authFailureInFlight = false;

export function setSignOutHandler(fn: SignOutHandler): void {
  signOutHandler = fn;
}

/** Test/teardown helper — undo `setSignOutHandler` and reset the latch. */
export function clearSignOutHandler(): void {
  signOutHandler = null;
  authFailureInFlight = false;
}

/**
 * Central persistent-401 exit. Ends the Clerk session when a handler is
 * wired (falling back to a plain login redirect otherwise), and latches so
 * concurrent 401s from parallel requests trigger exactly one navigation.
 */
export async function handleAuthFailure(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (window.location.pathname.startsWith('/login')) return;
  if (authFailureInFlight) return;
  authFailureInFlight = true;
  if (signOutHandler) {
    try {
      // ClerkProvider's afterSignOutUrl (/login) performs the navigation.
      await signOutHandler();
      return;
    } catch {
      // Sign-out failed (network, Clerk outage) — fall through to the
      // plain redirect rather than leaving the user stuck.
    }
  }
  redirectToLogin();
}

export type ApiFetch = (
  path: string,
  init?: RequestInit
) => Promise<Response>;

/** Clerk JWT template name required by the API (tenant_id + role claims). */
export const CLERK_JWT_TEMPLATE = 'serviceos' as const;

/**
 * Fetch a session token for the API. When the named JWT template is missing
 * in the Clerk dashboard, `getToken({ template })` returns null even though
 * the user is signed in — previously this looked identical to "signed out"
 * and caused a silent login redirect loop. Diagnose that case explicitly.
 *
 * @see docs/runbooks/clerk-setup.md
 */
export async function getServiceosToken(
  getToken: (opts?: { template?: string; skipCache?: boolean }) => Promise<string | null>,
  opts?: { skipCache?: boolean },
): Promise<string | null> {
  const token = await getToken({
    template: CLERK_JWT_TEMPLATE,
    skipCache: opts?.skipCache,
  });
  if (token) return token;

  // Distinguish "not signed in" from "template missing".
  let defaultToken: string | null = null;
  try {
    defaultToken = await getToken(opts?.skipCache ? { skipCache: true } : undefined);
  } catch {
    defaultToken = null;
  }
  if (defaultToken) {
    // Signed in, but the serviceos template did not mint a token.
    // eslint-disable-next-line no-console -- operator-facing misconfig signal
    console.error(
      `[apiClient] Clerk getToken({ template: '${CLERK_JWT_TEMPLATE}' }) returned null ` +
        'while a default session token exists. Create the JWT template named ' +
        `"${CLERK_JWT_TEMPLATE}" with tenant_id + role claims ` +
        '(docs/runbooks/clerk-setup.md).',
    );
  }
  return null;
}

/**
 * React hook that returns a fetch-shaped function with auth + 401 handling
 * baked in. The returned function is stable across renders for a given
 * Clerk `getToken` reference.
 */
export function useApiClient(): ApiFetch {
  const { getToken } = useAuth();

  return useCallback<ApiFetch>(
    async (path: string, init: RequestInit = {}): Promise<Response> => {
      // Build a plain Record<string,string>. RequestInit['headers']
      // can be a plain object, a Headers instance, or a string[][].
      // The naive spread approach silently dropped Headers / array
      // forms (Gemini PR #208 review).
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

      // Set a default Content-Type only for STRING bodies. fetch()
      // already infers the right Content-Type for FormData,
      // URLSearchParams, Blob, and ArrayBuffer; setting
      // application/json on those would corrupt the request
      // (Gemini PR #208 review).
      //
      // HTTP header names are case-insensitive, so the presence check MUST
      // be too: a caller-supplied lowercase 'content-type' previously did
      // not suppress the injected 'Content-Type', fetch merged the duplicate
      // keys into "application/json, application/json", and Express's JSON
      // parser dropped the body — every inbox batch approval 400'd
      // (journey QA 2026-07-02, bug 1).
      const hasContentType = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'content-type',
      );
      if (typeof init.body === 'string' && !hasContentType) {
        headers['Content-Type'] = 'application/json';
      }

      const needsAuth = shouldInjectAuth(path);

      if (needsAuth) {
        const token = await getServiceosToken(getToken);
        if (!token) {
          // Sign-out transition, no session, or missing JWT template.
          // Cancel — we MUST NOT send unauthenticated.
          throw makeUnauthenticatedAbort();
        }
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(path, { ...init, headers });

      if (response.status === 401 && needsAuth) {
        // Try once with a forcibly refreshed token before giving up. This
        // covers the normal token-expiry case without bouncing the user.
        const fresh = await getServiceosToken(getToken, { skipCache: true });
        if (fresh) {
          const retryHeaders: Record<string, string> = {
            ...headers,
            Authorization: `Bearer ${fresh}`,
          };
          const retry = await fetch(path, { ...init, headers: retryHeaders });
          if (retry.status !== 401) return retry;
        }
        // Still unauthorized after a refresh attempt — the server rejects a
        // session Clerk considers valid. End the session (single exit,
        // latched across concurrent 401s) instead of blind-redirecting.
        await handleAuthFailure();
        throw new Error('Unauthorized — redirecting to login');
      }

      return response;
    },
    [getToken]
  );
}
