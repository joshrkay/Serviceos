// Native bindings for the push pipeline (expo-notifications + Platform). Kept
// thin and RN-coupled so registerForPush.ts stays pure and testable.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { PushPermission } from './registerForPush';

export async function getPermission(): Promise<PushPermission> {
  const p = await Notifications.getPermissionsAsync();
  return { granted: p.granted, canAskAgain: p.canAskAgain };
}

export async function requestPermission(): Promise<{ granted: boolean }> {
  const p = await Notifications.requestPermissionsAsync();
  return { granted: p.granted };
}

export async function getExpoPushToken(): Promise<string | null> {
  try {
    const token = await Notifications.getExpoPushTokenAsync();
    return token.data ?? null;
  } catch {
    // No projectId / not a real device / no network — treat as unsupported.
    return null;
  }
}

export const devicePlatform: 'ios' | 'android' = Platform.OS === 'android' ? 'android' : 'ios';
