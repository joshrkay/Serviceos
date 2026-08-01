import { useAuth } from '@clerk/clerk-expo';
import { useCallback } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { getExpoPushToken } from './nativePushDeps';
import { unregisterForPush } from './registerForPush';

/**
 * Sign out, revoking this device's push token first (while the JWT is still
 * valid) so a signed-out install stops receiving the tenant's notifications.
 * Revocation is best-effort and never blocks the sign-out.
 */
export function useSignOut(): () => Promise<void> {
  const { signOut } = useAuth();
  const api = useApiClient();

  return useCallback(async () => {
    await unregisterForPush({ api, getExpoPushToken });
    await signOut();
  }, [api, signOut]);
}
