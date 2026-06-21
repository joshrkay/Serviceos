// Pure (RN-free) push-registration pipeline: ensure permission → get the Expo
// push token → POST it to the API. Native bits (expo-notifications, Platform)
// are injected so this unit-tests without a device. Best-effort: it returns a
// status rather than throwing, so a failure never blocks the app.
import type { ApiFetch } from '../lib/apiFetch';

export type RegisterPushResult = 'registered' | 'denied' | 'unsupported' | 'error';

/**
 * Result of resolving the Expo push token. `unsupported` is a permanent
 * condition (simulator / no push hardware) that must NOT be retried; `error`
 * is transient (offline, or a projectId-fetch timeout at launch) and a later
 * attempt may succeed. The old contract collapsed both into `null`, so a
 * transient launch-time failure looked permanent and latched the device out of
 * push for the whole signed-in session.
 */
export type ExpoTokenResult =
  | { status: 'ok'; token: string }
  | { status: 'unsupported' }
  | { status: 'error' };

/**
 * Classify a thrown `getExpoPushTokenAsync` error: a permanent unsupported
 * device (simulator / no push hardware) vs a transient failure (offline,
 * timeout). Pure, so it's unit-tested here; the native wrapper in
 * nativePushDeps.ts delegates to it.
 */
export function classifyExpoTokenError(err: unknown): 'unsupported' | 'error' {
  const code =
    typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'ERR_NOTIFICATIONS_DEVICE_NOT_SUPPORTED' || code === 'E_DEVICE_NOT_SUPPORTED') {
    return 'unsupported';
  }
  const message = err instanceof Error ? err.message : String(err);
  return /must use (a )?physical device|device (is )?not supported/i.test(message)
    ? 'unsupported'
    : 'error';
}

/**
 * Latch key for push registration: the active org/tenant when signed in, else
 * null. Keying the once-per-session guard by this value (not just a boolean)
 * makes an in-session org switch re-register the device token under the new
 * tenant — /api/devices stores tokens tenant-scoped, so a stale latch would
 * drop pushes for the newly active tenant until a remount.
 */
export function pushRegistrationKey(
  enabled: boolean,
  orgId: string | null | undefined,
): string | null {
  return enabled ? (orgId ?? 'personal') : null;
}

export interface PushPermission {
  granted: boolean;
  canAskAgain: boolean;
}

export interface RegisterPushDeps {
  /** Android-only: create the notification channel before the permission/token
   *  flow (required on Android 13+). No-op/absent on iOS. */
  ensureAndroidChannel?: () => Promise<void>;
  getPermission: () => Promise<PushPermission>;
  requestPermission: () => Promise<{ granted: boolean }>;
  getExpoPushToken: () => Promise<ExpoTokenResult>;
  api: ApiFetch;
  platform: 'ios' | 'android';
}

export interface UnregisterPushDeps {
  getExpoPushToken: () => Promise<ExpoTokenResult>;
  api: ApiFetch;
}

/**
 * Revoke this device's push token on sign-out (DELETE /api/devices) so a
 * signed-out install stops receiving the tenant's pushes. Best-effort — must
 * run before the Clerk session is torn down (the API call needs the JWT).
 */
export async function unregisterForPush(deps: UnregisterPushDeps): Promise<void> {
  try {
    const result = await deps.getExpoPushToken();
    if (result.status !== 'ok') return;
    await deps.api('/api/devices', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: result.token }),
    });
  } catch {
    // best-effort; the server also prunes dead tokens
  }
}

export async function registerForPush(deps: RegisterPushDeps): Promise<RegisterPushResult> {
  try {
    // Android 13+: the channel must exist before the permission prompt and
    // token lookup, or the owner ends up with no token and misses all pushes.
    if (deps.platform === 'android') await deps.ensureAndroidChannel?.();

    const current = await deps.getPermission();
    if (!current.granted) {
      if (!current.canAskAgain) return 'denied';
      const asked = await deps.requestPermission();
      if (!asked.granted) return 'denied';
    }

    const result = await deps.getExpoPushToken();
    if (result.status === 'unsupported') return 'unsupported'; // simulator / no push hardware
    if (result.status === 'error') return 'error'; // transient (offline/timeout) — caller retries

    const res = await deps.api('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: result.token, platform: deps.platform }),
    });
    return res.ok ? 'registered' : 'error';
  } catch {
    return 'error';
  }
}
