import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { setTokenGetter } from '../../utils/api-fetch';

/**
 * Invisible component that wires Clerk's getToken into the apiFetch utility.
 * Must be rendered inside <ClerkProvider>.
 */
export function AuthTokenBridge() {
  const { getToken } = useAuth();

  useEffect(() => {
    setTokenGetter(() => getToken());
  }, [getToken]);

  return null;
}
