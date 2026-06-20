// Pure (RN-free) push-registration pipeline: ensure permission → get the Expo
// push token → POST it to the API. Native bits (expo-notifications, Platform)
// are injected so this unit-tests without a device. Best-effort: it returns a
// status rather than throwing, so a failure never blocks the app.
import type { ApiFetch } from '../lib/apiFetch';

export type RegisterPushResult = 'registered' | 'denied' | 'unsupported' | 'error';

export interface PushPermission {
  granted: boolean;
  canAskAgain: boolean;
}

export interface RegisterPushDeps {
  getPermission: () => Promise<PushPermission>;
  requestPermission: () => Promise<{ granted: boolean }>;
  getExpoPushToken: () => Promise<string | null>;
  api: ApiFetch;
  platform: 'ios' | 'android';
}

export interface UnregisterPushDeps {
  getExpoPushToken: () => Promise<string | null>;
  api: ApiFetch;
}

/**
 * Revoke this device's push token on sign-out (DELETE /api/devices) so a
 * signed-out install stops receiving the tenant's pushes. Best-effort — must
 * run before the Clerk session is torn down (the API call needs the JWT).
 */
export async function unregisterForPush(deps: UnregisterPushDeps): Promise<void> {
  try {
    const token = await deps.getExpoPushToken();
    if (!token) return;
    await deps.api('/api/devices', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: token }),
    });
  } catch {
    // best-effort; the server also prunes dead tokens
  }
}

export async function registerForPush(deps: RegisterPushDeps): Promise<RegisterPushResult> {
  try {
    const current = await deps.getPermission();
    if (!current.granted) {
      if (!current.canAskAgain) return 'denied';
      const asked = await deps.requestPermission();
      if (!asked.granted) return 'denied';
    }

    const token = await deps.getExpoPushToken();
    if (!token) return 'unsupported'; // simulator / device without push support

    const res = await deps.api('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expoPushToken: token, platform: deps.platform }),
    });
    return res.ok ? 'registered' : 'error';
  } catch {
    return 'error';
  }
}
