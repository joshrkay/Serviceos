import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { routeForNotification } from './notificationRouting';
import {
  addForegroundListener,
  addResponseListener,
  getLastNotificationData,
} from './nativeNotificationDeps';

/**
 * Routes push notifications into the app: a tap (cold start via
 * getLastNotificationResponse, or while running via the response listener)
 * deep-links to the proposal review screen; a foreground notification does NOT
 * navigate — it just fires `onForeground` (badge/inbox refresh), preserving the
 * owner's context. Mounted once in the root layout.
 */
export function useNotificationRouter(onForeground?: () => void): void {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    void getLastNotificationData().then((data) => {
      if (cancelled) return;
      const route = routeForNotification(data);
      if (route) router.push(route);
    });

    const responseSub = addResponseListener((data) => {
      const route = routeForNotification(data);
      if (route) router.push(route);
    });

    const foregroundSub = addForegroundListener(() => {
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
