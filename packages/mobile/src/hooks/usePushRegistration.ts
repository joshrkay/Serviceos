import { useEffect, useRef } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { registerForPush } from '../push/registerForPush';
import {
  devicePlatform,
  getExpoPushToken,
  getPermission,
  requestPermission,
} from '../push/nativePushDeps';

/**
 * Registers this device for push once the owner is signed in (best-effort,
 * fire-and-forget). Runs a single time per signed-in session; the API upserts
 * by token, so a later re-register is harmless. Wired from the root layout's
 * auth gate.
 */
export function usePushRegistration(enabled: boolean): void {
  const api = useApiClient();
  const doneRef = useRef(false);

  useEffect(() => {
    // Sign-out: clear the guard so a re-sign-in (without remounting the root
    // layout) re-registers. useSignOut revokes the token on sign-out, so
    // leaving doneRef latched would silently drop pushes until an app restart.
    if (!enabled) {
      doneRef.current = false;
      return;
    }
    if (doneRef.current) return;
    doneRef.current = true;
    void registerForPush({
      getPermission,
      requestPermission,
      getExpoPushToken,
      api,
      platform: devicePlatform,
    });
  }, [enabled, api]);
}
