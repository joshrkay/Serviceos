/**
 * Capacitor environment detection — WITHOUT taking a hard dependency on
 * `@capacitor/core`.
 *
 * Capacitor injects a global `window.Capacitor` inside the native iOS/Android
 * WebView; on the plain web build that global is absent. Reading it here (vs.
 * importing the package) keeps every native-only path — push registration,
 * biometric lock, the offline queue, deep links — a clean no-op on web, and
 * avoids pulling native plugins into the production web bundle. The native
 * shell package (`packages/mobile`) wires the real plugins.
 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function capacitor(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True only inside the native iOS/Android Capacitor WebView. */
export function isNativePlatform(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** 'ios' | 'android' | 'web' — best-effort; 'web' when not running natively. */
export function getPlatform(): string {
  return capacitor()?.getPlatform?.() ?? 'web';
}
