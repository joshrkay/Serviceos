// Resolve-time stub for react-native-safe-area-context under the jsdom test
// env. The real package has a native entry that doesn't resolve in the
// root-only CI lane; tests don't measure real insets, so zero is correct and
// components fall back to their min padding (Math.max(inset, 8)).
import { createElement, type ReactNode } from 'react';

export function useSafeAreaInsets() {
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

export const SafeAreaProvider = ({ children }: { children?: ReactNode }) =>
  createElement('div', null, children as ReactNode);

export const initialWindowMetrics = null;
