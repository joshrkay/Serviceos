// Thin expo-notifications bindings for the notification router. Kept RN-coupled
// (and excluded from coverage) so useNotificationRouter stays testable against
// these seams. Foreground notifications now present an in-app banner (+ badge);
// high-priority types (incoming call / escalation / emergency) also play a
// sound so the owner can't miss them.
import * as Notifications from 'expo-notifications';
import {
  isHighPriorityNotification,
  type NotificationType,
} from '@ai-service-os/shared';

export type NotificationData = Record<string, unknown> | undefined;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const type = notification.request.content.data?.type as NotificationType | undefined;
    const highPriority = type ? isHighPriorityNotification(type) : false;
    return {
      // Present the banner for every foreground notification — the owner sees
      // what just happened without leaving the current screen.
      shouldShowAlert: true,
      // Only interrupt with a sound for time-critical types.
      shouldPlaySound: highPriority,
      shouldSetBadge: true,
    };
  },
});

/** Data of the notification the app was last opened from (cold start), if any. */
export async function getLastNotificationData(): Promise<NotificationData> {
  const resp = await Notifications.getLastNotificationResponseAsync();
  return resp?.notification.request.content.data as NotificationData;
}

/** A notification tap while the app is running. */
export function addResponseListener(cb: (data: NotificationData) => void): { remove: () => void } {
  return Notifications.addNotificationResponseReceivedListener((r) =>
    cb(r.notification.request.content.data as NotificationData),
  );
}

/** A notification arriving while the app is foregrounded. */
export function addForegroundListener(cb: () => void): { remove: () => void } {
  return Notifications.addNotificationReceivedListener(() => cb());
}
