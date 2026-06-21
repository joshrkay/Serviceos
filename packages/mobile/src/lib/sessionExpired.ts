/**
 * Session-expired re-auth plumbing (pure).
 *
 * When a request 401s and can't be refreshed, `useApiClient` routes to sign-in
 * carrying two things: a `reason` so the screen can explain *why* the owner
 * landed there ("your session expired" rather than a cold sign-in), and a `next`
 * path so a successful re-auth resumes where they were instead of dropping them
 * on Home. The href building and param reading are isolated here so they're
 * unit-tested without a router.
 */
import type { Href } from 'expo-router';

/** Marker the sign-in screen reads to switch into the "session expired" copy. */
export const SESSION_EXPIRED_REASON = 'session-expired';

/** Paths we never resume to after re-auth (auth flow itself, Home is the default). */
function isResumableNext(path: string | undefined): path is string {
  if (!path) return false;
  if (!path.startsWith('/')) return false;
  if (path === '/') return false;
  if (path.startsWith('/sign-in') || path.startsWith('/(auth)')) return false;
  return true;
}

/** Build the sign-in route for an expired session, preserving a resumable `next`. */
export function signInExpiredHref(currentPath?: string): Href {
  const params: Record<string, string> = { reason: SESSION_EXPIRED_REASON };
  if (isResumableNext(currentPath)) params.next = currentPath;
  return { pathname: '/sign-in', params } as Href;
}

/** Normalize a possibly-array route param to a single string. */
function firstParam(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value) ?? undefined;
}

export interface SessionExpiredParams {
  /** True when sign-in was reached because the session expired. */
  expired: boolean;
  /** A resumable path to return to after re-auth, if one was preserved. */
  next: string | undefined;
}

/** Read the session-expired signal + resume path out of sign-in's route params. */
export function readSessionExpiredParams(params: {
  reason?: string | string[];
  next?: string | string[];
}): SessionExpiredParams {
  const reason = firstParam(params.reason);
  const next = firstParam(params.next);
  return {
    expired: reason === SESSION_EXPIRED_REASON,
    next: isResumableNext(next) ? next : undefined,
  };
}
