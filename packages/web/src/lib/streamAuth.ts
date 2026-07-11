/**
 * Shared 401/403 handling for hand-rolled streaming/polling requests.
 *
 * ARCH-30 — useDispatchBoardStream, useEscalationStream, useVoiceSession,
 * and useActiveSessions each open their own SSE/WS/poll connections with
 * `fetch()` directly (they need the raw `Response` — a streaming body, or a
 * WS upgrade token — so they can't go through `useApiClient`/`apiFetch`,
 * which are JSON-request shaped). Before this fix each one reimplemented
 * "attach a token, handle a 401" differently and divergently:
 *
 *   - useDispatchBoardStream: 401/403 → `return` — the SSE loop just stops,
 *     silently, with no reconnect and no user-visible signal.
 *   - useEscalationStream: 401/403 → retry once with a refreshed token, then
 *     back off and retry forever — never signs the user out even when the
 *     server keeps rejecting a session Clerk still considers valid.
 *   - useVoiceSession: 401/403 → sets `ended` and stops, no retry, no
 *     sign-out.
 *   - useActiveSessions: swallows a 401 into the generic
 *     network-error/backoff branch — indistinguishable from a transient
 *     blip.
 *
 * This module extracts the one correct behavior — already proven out in
 * `lib/apiClient.ts` / `utils/api-fetch.ts` — as a plain function so all
 * four hooks share it:
 *
 *   1. No token available at all → throw the same `AbortError` shape
 *      `apiClient.ts` uses (`makeUnauthenticatedAbort`) rather than firing
 *      an unauthenticated request. Callers already treat a thrown/aborted
 *      attempt as "retry shortly" via their existing reconnect/backoff path.
 *   2. 401 or 403 response → retry ONCE with a forcibly-refreshed token
 *      (`getToken({ skipCache: true })`).
 *   3. Still 401/403 after the refreshed retry → the server is rejecting a
 *      session the client still holds locally; route through the shared
 *      `handleAuthFailure()` exit (Clerk sign-out, or a plain /login
 *      redirect, latched against concurrent 401s from other hooks/tabs of
 *      the request layer) exactly like the JSON clients do. The failing
 *      Response is returned (not thrown) so each hook keeps its own
 *      reconnect/error-surfacing shape for the non-auth case.
 *
 * 401 and 403 are treated identically here (unlike `apiClient.ts`, which
 * only retries on 401) because that's the convention these streaming hooks
 * already used before this fix — the gateway can return either for a
 * stale/rejected token depending on the route.
 */
import { handleAuthFailure, makeUnauthenticatedAbort } from './apiClient';

/**
 * Minimal shape of Clerk's `getToken` the hooks already have via
 * `useAuth()`. Callers bind their template (e.g. `{ template: 'serviceos' }`)
 * into this function so `fetchWithAuthRetry` only needs to pass
 * `skipCache`.
 */
export type StreamTokenGetter = (opts?: { skipCache?: boolean }) => Promise<string | null>;

const AUTH_REJECTED_STATUSES = new Set([401, 403]);

/** True for the status codes this module treats as "auth rejected". */
export function isAuthRejectedStatus(status: number): boolean {
  return AUTH_REJECTED_STATUSES.has(status);
}

/**
 * Fetches `input` with a Bearer token attached, retrying once with a
 * forcibly-refreshed token on a 401/403, and routing through
 * `handleAuthFailure()` if the retry is also rejected. See module doc for
 * the full contract.
 */
export async function fetchWithAuthRetry(
  getToken: StreamTokenGetter,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getToken();
  if (!token) {
    // Sign-out transition or no active session — never send unauthenticated.
    throw makeUnauthenticatedAbort();
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(input, { ...init, headers });
  if (!isAuthRejectedStatus(response.status)) return response;

  const fresh = await getToken({ skipCache: true });
  if (fresh) {
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set('Authorization', `Bearer ${fresh}`);
    const retry = await fetch(input, { ...init, headers: retryHeaders });
    if (!isAuthRejectedStatus(retry.status)) return retry;
    await handleAuthFailure();
    return retry;
  }

  // Could not refresh at all — same terminal outcome as a rejected retry.
  await handleAuthFailure();
  return response;
}
