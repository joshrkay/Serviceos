import type { MeResponse } from '../api/me';

/**
 * Module-level `/api/me` cache, keyed by Clerk identity. The first read for a
 * given `key` (the Clerk user id) starts the load and stores the in-flight
 * promise; later reads with the SAME key reuse it. A DIFFERENT key — e.g. the
 * device signed out and back in as another user without restarting the JS
 * runtime — invalidates the prior entry so the new session never sees the
 * previous user's tenant/role/mode. Errors clear the cache so the next read
 * retries instead of caching a rejection.
 */
let cached: { key: string; promise: Promise<MeResponse> } | null = null;

export function getOrLoadMe(
  key: string,
  load: () => Promise<MeResponse>,
): Promise<MeResponse> {
  if (!cached || cached.key !== key) {
    cached = {
      key,
      promise: load().catch((err) => {
        cached = null;
        throw err;
      }),
    };
  }
  return cached.promise;
}

/** Drop the cache (called on mode switch / forced refresh / tests). */
export function invalidateMeCache(): void {
  cached = null;
}
