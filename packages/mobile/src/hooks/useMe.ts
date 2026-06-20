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
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const { userId, orgId, sessionId } = useAuth();
  const client = useApiClient() as AuthedFetch;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Key the cache by the full Clerk identity. The API's tenant boundary is the
  // JWT `tenant_id` claim (from public_metadata — see
  // packages/api/src/auth/clerk.ts), NOT Clerk's org, and `orgId` can be null
  // in deployments that don't use Clerk Organizations. So include `sessionId`:
  // a sign-out/sign-in (the case where the same RN runtime would otherwise
  // serve the prior tenant's payload) starts a new session and a fresh key.
  // `orgId` still distinguishes org switches; `anon` covers the signed-out gap.
  const cacheKey = `${userId ?? 'anon'}:${orgId ?? ''}:${sessionId ?? ''}`;

  // Monotonic request id: an identity switch (or refetch) starts a newer load,
  // so a slower in-flight request for the prior identity must not commit its
  // result last. Each load tags itself and only writes state while it is still
  // the latest — otherwise a sign-out/sign-in or org-switch race could render
  // the previous tenant/role/mode. The ref is shared across all load closures.
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (forceRefresh = false) => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setError(null);
      try {
        if (forceRefresh) invalidateMeCache();
        const result = await getOrLoadMe(cacheKey, () => fetchMe(client));
        if (requestId !== requestIdRef.current) return; // superseded by a newer load
        setMe(result);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (requestId === requestIdRef.current) setIsLoading(false);
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
