import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/clerk-expo';
import { useApiClient } from '../lib/useApiClient';
import { pushRegistrationKey, registerForPush, type RegisterPushResult } from '../push/registerForPush';
import {
  devicePlatform,
  ensureAndroidChannel,
  getExpoPushToken,
  getPermission,
  requestPermission,
} from '../push/nativePushDeps';

/** The last registration outcome; `null` until the first attempt resolves. */
export type PushStatus = RegisterPushResult | null;

/**
 * Registers this device for push once the owner is signed in (best-effort,
 * fire-and-forget). Runs once per active tenant/session; the API upserts by
 * token, so a later re-register is harmless. Wired from the root layout's auth
 * gate.
 *
 * Returns the last outcome so the UI can nudge the owner when permission was
 * denied (`'denied'`) — push otherwise fails silently and they never learn why
 * alerts stopped. `'registered' | 'unsupported' | 'error'` need no surface.
 */
export function usePushRegistration(enabled: boolean): PushStatus {
  const api = useApiClient();
  const { orgId } = useAuth();
  const [status, setStatus] = useState<PushStatus>(null);
  // Latch keyed by the ACTIVE org/tenant, not just the signed-in boolean.
  // Switching orgs in-session (without sign-out) changes the key, so the device
  // re-registers its token under the new auth.tenantId — /api/devices stores
  // tokens tenant-scoped, so a stale latch would drop pushes for the newly
  // active tenant until a remount. Sign-out (key === null) clears it so a
  // re-sign-in re-registers.
  const registeredKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const key = pushRegistrationKey(enabled, orgId);
    if (key === null) {
      registeredKeyRef.current = null;
      setStatus(null); // signed out — clear any prior nudge
      return;
    }
    if (registeredKeyRef.current === key) return;
    // Latch up front to prevent concurrent runs, but only *keep* it latched on a
    // terminal result for THIS key. A transient failure ('error': offline / API
    // blip at launch) unlatches so the next render retries; 'registered' /
    // 'denied' / 'unsupported' stay latched.
    registeredKeyRef.current = key;
    void registerForPush({
      ensureAndroidChannel,
      getPermission,
      requestPermission,
      getExpoPushToken,
      api,
      platform: devicePlatform,
    }).then((result) => {
      setStatus(result);
      if (result === 'error' && registeredKeyRef.current === key) {
        registeredKeyRef.current = null;
      }
    });
  }, [enabled, api, orgId]);

  return status;
}
