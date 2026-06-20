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
 * fire-and-forget). Runs a single time per mount; the API upserts by token, so
 * a later re-register is harmless. Wired from the root layout's auth gate.
 */
export function usePushRegistration(enabled: boolean): void {
  const api = useApiClient();
  const doneRef = useRef(false);

  useEffect(() => {
    if (!enabled || doneRef.current) return;
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
