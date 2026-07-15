import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setTokenGetter } from '../../utils/api-fetch';
import {
  clearSignOutHandler,
  getServiceosToken,
  setSignOutHandler,
} from '../../lib/apiClient';
import { invalidateMeCache } from '../../hooks/useMe';
import { invalidateOnboardingStatusCache } from '../../hooks/useOnboardingStatus';
import { invalidatePendingProposalsCache } from '../../hooks/usePendingProposals';
import { clearWorkerTermCache } from '../../hooks/useWorkerTerm';
import { clearEstimateTermCache } from '../../hooks/useEstimateTerm';

/**
 * Clear every module-level cache keyed to the current identity. These caches
 * (me, onboarding status, pending proposals, tenant terminology) live for the
 * JS lifetime and are otherwise only reset by a full page reload — so a soft
 * navigation across a sign-out / sign-in / org switch would serve the previous
 * user's data to the new session.
 */
function invalidateIdentityCaches(): void {
  invalidateMeCache();
  invalidateOnboardingStatusCache();
  invalidatePendingProposalsCache();
  clearWorkerTermCache();
  clearEstimateTermCache();
}

/**
 * Invisible component that wires Clerk's getToken into the apiFetch utility.
 * Must be rendered inside <ClerkProvider>.
 *
 * Passes a `forceRefresh`-aware getter so apiFetch's 401-retry path can
 * bypass Clerk's client-side token cache via `getToken({ skipCache: true })`.
 * Without this, an expired-but-cached token would loop through retry with
 * the same stale value until the cache TTL elapsed.
 *
 * Also wires Clerk's signOut as the persistent-401 exit: when the API
 * rejects tokens the client session still considers valid, both fetch
 * layers end the session (navigating via ClerkProvider's afterSignOutUrl)
 * instead of redirecting to /login signed-in — which LoginPage would
 * immediately bounce back, looping the app (dev-env outage 2026-07-06).
 */
export function AuthTokenBridge() {
  const { getToken, signOut, userId, sessionId } = useAuth();

  useEffect(() => {
    setTokenGetter((opts) =>
      getServiceosToken(getToken, { skipCache: opts?.forceRefresh ?? false }),
    );
  }, [getToken]);

  useEffect(() => {
    setSignOutHandler(() => signOut());
    return () => clearSignOutHandler();
  }, [signOut]);

  // Drop identity-scoped module caches whenever the Clerk user or session
  // changes. The first render establishes the baseline; every change after
  // it (sign-out → null, sign-in as someone else, org/tenant switch) clears
  // the caches so no consumer serves stale identity.
  const identityRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${userId ?? ''}:${sessionId ?? ''}`;
    if (identityRef.current !== null && identityRef.current !== key) {
      invalidateIdentityCaches();
    }
    identityRef.current = key;
  }, [userId, sessionId]);

  return null;
}
