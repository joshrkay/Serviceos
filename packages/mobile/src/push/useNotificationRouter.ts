import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { isEmergencyNotification, routeForNotification } from './notificationRouting';
import { raiseEmergency } from './emergencyBanner';
import {
  addForegroundListener,
  addResponseListener,
  getLastNotificationData,
} from './nativeNotificationDeps';

/**
 * Routes push notifications into the app: a tap (cold start via
 * getLastNotificationResponse, or while running via the response listener)
 * deep-links to the notification's target screen (an allowlisted path, else
 * Home); a foreground notification does NOT navigate — it just fires
 * `onForeground` (badge/inbox refresh), preserving the owner's context. Mounted
 * once in the root layout.
 */
export function useNotificationRouter(onForeground?: () => void): void {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void getLastNotificationData().then((data) => {
      if (cancelled) return;
      // Only navigate when the app was actually launched from a notification —
      // a bare cold start has no launch data and must not force a route.
      if (data) router.push(routeForNotification(data));
    });

    const responseSub = addResponseListener((data) => {
      router.push(routeForNotification(data));
    });

    const foregroundSub = addForegroundListener((data) => {
      // U4 (B7) — an escalation/emergency arriving while the app is open would
      // otherwise be swallowed by foreground OS-banner suppression; raise the
      // Home emergency banner so it cannot be missed.
      if (isEmergencyNotification(data)) raiseEmergency(data as Record<string, unknown>);
      onForeground?.();
    });

    return () => {
      cancelled = true;
      responseSub.remove();
      foregroundSub.remove();
    };
    // onForeground intentionally omitted — callers pass a stable callback and we
    // only want to (re)wire listeners when the router identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);
}
