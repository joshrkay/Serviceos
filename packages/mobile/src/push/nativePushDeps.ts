// Native bindings for the push pipeline (expo-notifications + Platform). Kept
// thin and RN-coupled so registerForPush.ts stays pure and testable.
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { classifyExpoTokenError, type ExpoTokenResult, type PushPermission } from './registerForPush';

/**
 * Resolve the EAS projectId for push-token minting. In a standalone / production
 * EAS build there is no dev-client to auto-resolve it, so
 * `getExpoPushTokenAsync` must be passed the projectId explicitly or it throws —
 * which would latch EVERY production user out of push. `eas init` writes it into
 * app.json (`expo.extra.eas.projectId`); an `EAS_PROJECT_ID` env override is
 * also honored. Returns undefined in dev before `eas init`, where the
 * dev-client resolves the id on its own (so the bare call still works locally).
 */
function resolveProjectId(): string | undefined {
  const fromConfig = (
    Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  )?.eas?.projectId;
  const fromEnv = process.env.EAS_PROJECT_ID;
  const id = fromConfig || fromEnv;
  return id && id.length > 0 ? id : undefined;
}

export async function getPermission(): Promise<PushPermission> {
  const p = await Notifications.getPermissionsAsync();
  return { granted: p.granted, canAskAgain: p.canAskAgain };
}

export async function requestPermission(): Promise<{ granted: boolean }> {
  const p = await Notifications.requestPermissionsAsync();
  return { granted: p.granted };
}

/**
 * Android 13+ requires a notification channel to exist before the permission
 * prompt will appear and before getExpoPushTokenAsync works (per Expo's
 * notifications docs). No-op on iOS. Best-effort — callers swallow failures.
 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
  });
}

export async function getExpoPushToken(): Promise<ExpoTokenResult> {
  try {
    // Pass the projectId explicitly so standalone/production builds (no
    // dev-client) can mint a token; omit it in dev where Expo auto-resolves.
    const projectId = resolveProjectId();
    const token = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return token.data ? { status: 'ok', token: token.data } : { status: 'unsupported' };
  } catch (err) {
    // expo-notifications throws on simulators / devices without push hardware
    // (permanent → 'unsupported') AND on transient failures such as no network
    // or a projectId-fetch timeout at launch (→ 'error', so the caller retries
    // instead of latching the device out of push for the whole session).
    return { status: classifyExpoTokenError(err) };
  }
}

export const devicePlatform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';
