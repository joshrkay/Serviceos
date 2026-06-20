// Thin expo-notifications bindings for the notification router. Kept RN-coupled
// (and excluded from coverage) so useNotificationRouter stays testable against
// these seams. Suppress the OS banner for foreground notifications — the app
// surfaces them as an in-app badge refresh instead.
import * as Notifications from 'expo-notifications';

export type NotificationData = Record<string, unknown> | undefined;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
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
