import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setTokenGetter } from '../../utils/api-fetch';

/**
 * Invisible component that wires Clerk's getToken into the apiFetch utility.
 * Must be rendered inside <ClerkProvider>.
 *
 * Passes a `forceRefresh`-aware getter so apiFetch's 401-retry path can
 * bypass Clerk's client-side token cache via `getToken({ skipCache: true })`.
 * Without this, an expired-but-cached token would loop through retry with
 * the same stale value until the cache TTL elapsed.
 */
export function AuthTokenBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setTokenGetter((opts) =>
      getToken({ template: 'serviceos', skipCache: opts?.forceRefresh ?? false }),
    );
  }, [getToken]);

  return null;
}
