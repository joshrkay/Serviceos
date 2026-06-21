import { useAuth } from '@clerk/clerk-expo';
import { usePathname, useRouter } from 'expo-router';
import { useMemo, useRef } from 'react';
import { createApiFetch, type ApiFetch } from './apiFetch';
import { API_BASE_URL } from './env';
import { useToast } from '../components/Toast';
import { signInExpiredHref } from './sessionExpired';

/**
 * Returns a fetch-shaped client with the Clerk JWT + 401 handling baked in —
 * the RN equivalent of web's `useApiClient`. Reuses the exact `serviceos` JWT
 * template so the API's RLS claims (tenantId, role, mode) populate identically.
 *
 * On a session that can't be refreshed (the 401-retry in `apiFetch` exhausted),
 * we surface a session-expired toast and route to sign-in carrying the current
 * path as `next`, so re-auth resumes where the owner was instead of dropping
 * them on Home. The refresh-first behavior and the AbortError sign-out swallow
 * in `apiFetch`/`decodeError` are untouched — this only enriches the terminal
 * `onUnauthenticated`.
 */
export function useApiClient(): ApiFetch {
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { showToast } = useToast();

  // The fetch client is memoized for identity stability, but `onUnauthenticated`
  // must always see the *current* route. Read it from a ref the render keeps fresh
  // so we don't rebuild the client (and refetch every hook) on each navigation.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  return useMemo<ApiFetch>(
    () =>
      createApiFetch({
        baseUrl: API_BASE_URL,
        getToken: (opts) =>
          getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
        onUnauthenticated: () => {
          showToast({
            title: 'Your session expired',
            body: 'Please sign in again.',
            tone: 'info',
          });
          router.replace(signInExpiredHref(pathnameRef.current));
        },
      }),
    [getToken, router, showToast],
  );
}
