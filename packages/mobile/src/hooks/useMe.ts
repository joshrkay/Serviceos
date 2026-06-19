/**
 * `useMe` — single source of truth for the authenticated user, tenant, role,
 * and current mode. Ported from `packages/web/src/hooks/useMe.ts`.
 *
 * Module-level cache: the first mount kicks off the fetch and stores the
 * in-flight promise; subsequent mounts reuse it. `switchMode` invalidates the
 * cache so the next read hits the server. The cache is cleared on error so a
 * retry actually re-fetches.
 */
import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import {
  fetchMe,
  postModeSwitch,
  type AuthedFetch,
  type Mode,
  type MeResponse,
} from '../api/me';

export type { Mode, MeResponse };

export interface UseMeResult {
  me: MeResponse | null;
  isLoading: boolean;
  error: Error | null;
  /** Switch the current mode and refetch. Throws if the server rejects it. */
  switchMode: (next: Mode) => Promise<void>;
  refetch: () => Promise<void>;
}

let cachedMePromise: Promise<MeResponse> | null = null;

function loadOrReuse(client: AuthedFetch): Promise<MeResponse> {
  if (!cachedMePromise) {
    cachedMePromise = fetchMe(client).catch((err) => {
      cachedMePromise = null; // don't poison the cache on transient failures
      throw err;
    });
  }
  return cachedMePromise;
}

/** Test-only: drop the module cache so cases don't bleed into each other. */
export function _resetMeCacheForTests(): void {
  cachedMePromise = null;
}

export function useMe(): UseMeResult {
  const client = useApiClient() as AuthedFetch;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    async (forceRefresh = false) => {
      setIsLoading(true);
      setError(null);
      try {
        if (forceRefresh) cachedMePromise = null;
        setMe(await loadOrReuse(client));
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const switchMode = useCallback(
    async (next: Mode) => {
      await postModeSwitch(client, next);
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
