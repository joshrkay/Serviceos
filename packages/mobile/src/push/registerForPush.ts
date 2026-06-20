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
