/**
 * `useMe` — single source of truth for the authenticated user, tenant, role,
 * and current mode. Ported from `packages/web/src/hooks/useMe.ts`.
 *
 * The `/api/me` cache is keyed by Clerk identity (see meCache.ts): unlike web,
 * the RN JS runtime survives sign-out/sign-in, so a module cache that ignored
 * identity would render the previous user's tenant/role until a manual
 * refetch. `switchMode` invalidates the cache so the next read hits the server.
 */
import { useAuth } from '@clerk/clerk-expo';
import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import {
  fetchMe,
  postModeSwitch,
  type AuthedFetch,
  type Mode,
  type MeResponse,
} from '../api/me';
import { getOrLoadMe, invalidateMeCache } from './meCache';

export type { Mode, MeResponse };

export interface UseMeResult {
  me: MeResponse | null;
  isLoading: boolean;
  error: Error | null;
  /** Switch the current mode and refetch. Throws if the server rejects it. */
  switchMode: (next: Mode) => Promise<void>;
  refetch: () => Promise<void>;
}

/** Test-only: drop the module cache so cases don't bleed into each other. */
export function _resetMeCacheForTests(): void {
  invalidateMeCache();
}

export function useMe(): UseMeResult {
  const { userId } = useAuth();
  const client = useApiClient() as AuthedFetch;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Key the cache by the Clerk user id so a different session never reuses the
  // prior user's payload. `anon` covers the signed-out gap.
  const cacheKey = userId ?? 'anon';

  const load = useCallback(
    async (forceRefresh = false) => {
      setIsLoading(true);
      setError(null);
      try {
        if (forceRefresh) invalidateMeCache();
        setMe(await getOrLoadMe(cacheKey, () => fetchMe(client)));
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    },
    [client, cacheKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const switchMode = useCallback(
    async (next: Mode) => {
      await postModeSwitch(client, next);
      invalidateMeCache();
      await load(true);
    },
    [client, load],
  );

  const refetch = useCallback(async () => {
    await load(true);
  }, [load]);

  return { me, isLoading, error, switchMode, refetch };
}
