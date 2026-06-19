import { useAuth } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { createApiFetch, type ApiFetch } from './apiFetch';
import { API_BASE_URL } from './env';

/**
 * Returns a fetch-shaped client with the Clerk JWT + 401 handling baked in —
 * the RN equivalent of web's `useApiClient`. Reuses the exact `serviceos` JWT
 * template so the API's RLS claims (tenantId, role, mode) populate identically.
 */
export function useApiClient(): ApiFetch {
  const { getToken } = useAuth();
  const router = useRouter();

  return useMemo<ApiFetch>(
    () =>
      createApiFetch({
        baseUrl: API_BASE_URL,
        getToken: (opts) =>
          getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
        onUnauthenticated: () => router.replace('/sign-in'),
      }),
    [getToken, router],
  );
}
