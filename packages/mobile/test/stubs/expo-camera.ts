// Resolve-time stub for expo-camera under the jsdom/node test env (mobile-only
// native dep; doesn't resolve in the root-only lane). The screen test overrides
// these via vi.mock to drive capture + permission flows; this default just
// keeps imports resolvable.
import { createElement, forwardRef } from 'react';

export const CameraView = forwardRef((_props: Record<string, unknown>, _ref) =>
  createElement('div', { 'data-testid': 'camera-view' }),
);

export const useCameraPermissions = () =>
  [{ granted: true }, async () => ({ granted: true })] as const;
