/**
 * P12-002 — `useMe` hook.
 *
 * Single source of truth for "who is the authenticated user, what tenant
 * are they in, what role + mode + permissions do they have." Replaces
 * ad-hoc `useUser()` + localStorage('serviceos.permissions') reads
 * scattered across pages.
 *
 * Module-level cache (per the P12-002 review fix). The first hook
 * instance kicks off a fetch and stores the in-flight `Promise`; any
 * subsequent mounts during the same session reuse it instead of
 * issuing redundant requests. `switchMode` invalidates the cache so
 * the next read goes to the server.
 *
 * Errors are surfaced as state on the hook; callers can react. The
 * cached promise is cleared on error so a retry actually re-fetches.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../lib/apiClient';
import {
  fetchMe,
  postModeSwitch,
  type AuthedFetch,
  type Mode,
  type MeResponse,
} from '../api/me';

export type { Mode, MeResponse };

export interface UseMeResult {
  /** Latest /api/me response, or `null` while the first fetch is in flight. */
  me: MeResponse | null;
  isLoading: boolean;
  error: Error | null;
  /**
   * Switches the user's current mode and refetches `me`. Throws if the
   * server rejects the mode (e.g. 403 for a dispatcher without
   * `can_field_serve` requesting `tech`); the caller should surface a
   * toast / inline error and keep the UI on the prior mode.
   */
  switchMode: (next: Mode) => Promise<void>;
  /** Force-refresh from the server (no-op if no fetch is in-flight). */
  refetch: () => Promise<void>;
}

// Module-level cached promise. The first useMe call kicks off the
// fetch and stores it; subsequent mounts in the same browser session
// reuse the same promise so we never issue more than one request per
// "session" of identity. `invalidateMeCache()` resets it on writes
// (switchMode) so the next read sees the server.
let cachedMePromise: Promise<MeResponse> | null = null;

function loadOrReuse(client: AuthedFetch): Promise<MeResponse> {
  if (!cachedMePromise) {
    cachedMePromise = fetchMe(client).catch((err) => {
      // Don't poison the cache on transient failures — clear so the
      // next caller actually retries.
      cachedMePromise = null;
      throw err;
    });
  }
  return cachedMePromise;
}

/** Test-only: drop the module cache so test cases don't bleed into each other. */
export function _resetMeCacheForTests(): void {
  cachedMePromise = null;
}

/**
 * Drop the cached identity so the next read hits the server. Call on any
 * Clerk auth transition (sign-out, sign-in as a different user, org/tenant
 * switch) — otherwise a soft navigation without a full page reload keeps
 * serving the previous user's identity, role, and permissions.
 */
export function invalidateMeCache(): void {
  cachedMePromise = null;
}

/**
 * Shared cached /api/me read for non-hook consumers (e.g. the
 * TenantTimezoneProvider) so they piggyback on the same module cache
 * instead of issuing their own duplicate GET /api/me per mount.
 */
export function fetchMeShared(client: AuthedFetch): Promise<MeResponse> {
  return loadOrReuse(client);
}

export interface UseMeOptions {
  /**
   * When false, the hook does not fetch (isLoading settles to false,
   * me stays null). Lets root-mounted consumers (AnalyticsIdentityBridge)
   * defer the authenticated GET /api/me until Clerk reports a signed-in
   * session, instead of firing it on /login and feeding the 401 storm.
   */
  enabled?: boolean;
}

export function useMe(options: UseMeOptions = {}): UseMeResult {
  const enabled = options.enabled !== false;
  const client = useApiClient() as AuthedFetch;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (forceRefresh = false) => {
      setIsLoading(true);
      setError(null);
      try {
        if (forceRefresh) {
          cachedMePromise = null;
        }
        const response = await loadOrReuse(client);
        setMe(response);
      } catch (err) {
        // A deliberately cancelled request (no auth token — sign-out
        // transition) is not a user-facing error; mirrors the sibling
        // hooks (useOnboardingStatus, useListQuery).
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void load();
  }, [load, enabled]);

  const switchMode = useCallback(
    async (next: Mode) => {
      await postModeSwitch(client, next);
      // Invalidate so every consumer re-reads the new mode/state.
      cachedMePromise = null;
      await load(true);
    },
    [client, load],
  );

  const refetch = useCallback(async () => {
    await load(true);
  }, [load]);

  return { me, isLoading, error, switchMode, refetch };
}
