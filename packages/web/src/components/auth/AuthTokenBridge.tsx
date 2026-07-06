import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setTokenGetter } from '../../utils/api-fetch';
import { clearSignOutHandler, setSignOutHandler } from '../../lib/apiClient';

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
  const { getToken, signOut } = useAuth();

  useEffect(() => {
    setTokenGetter((opts) =>
      getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
    );
  }, [getToken]);

  useEffect(() => {
    setSignOutHandler(() => signOut());
    return () => clearSignOutHandler();
  }, [signOut]);

  return null;
}
