import { useEffect, useRef } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { registerForPush } from '../push/registerForPush';
import {
  devicePlatform,
  ensureAndroidChannel,
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
    // Latch up front to prevent concurrent runs, but only *keep* it latched on a
    // terminal result. A transient failure (offline / API blip at launch)
    // returns 'error' → unlatch so the next render (e.g. token refresh) retries,
    // instead of leaving the owner without pushes for the whole session.
    doneRef.current = true;
    void registerForPush({
      ensureAndroidChannel,
      getPermission,
      requestPermission,
      getExpoPushToken,
      api,
      platform: devicePlatform,
    }).then((result) => {
      if (result === 'error') doneRef.current = false;
    });
  }, [enabled, api]);
}
