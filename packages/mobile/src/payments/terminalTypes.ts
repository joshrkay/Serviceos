import { NativeModules, Platform } from 'react-native';

/**
 * True only on a native build where the Terminal Expo config plugin linked
 * `StripeTerminalReactNative`. Expo Go / web export stay false and fall back
 * to pay-link / cash CTAs.
 */
export function isTerminalSdkAvailable(): boolean {
  if (Platform.OS === 'web') return false;
  return NativeModules?.StripeTerminalReactNative != null;
}

export type TerminalCollectResult =
  | { status: 'succeeded'; paymentIntentId: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; message: string };

export const TERMINAL_UNAVAILABLE_REASON =
  'In-person card collect requires a Terminal-enabled EAS build (not Expo Go). Use the pay link or record cash for now.';
