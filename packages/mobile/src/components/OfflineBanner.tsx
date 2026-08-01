/**
 * Persistent connectivity + offline-queue banner.
 *
 * Sits above the whole tree (mounted in `app/_layout.tsx`). Two jobs:
 *  - While offline, show the "you're offline" state (driven by NetInfo via
 *    `subscribeConnectivity`); on reconnect the read hooks heal themselves.
 *  - Surface the offline queue depth (U12) — "N actions waiting" — so the owner
 *    knows captured voice notes / approvals are pending a flush. Shown while
 *    offline (appended to the offline copy) and briefly while online as the
 *    queue drains on reconnect. Renders nothing when online with an empty queue.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { subscribeConnectivity } from '../lib/connectivity';
import { subscribeWaitingCount } from '../offline/waitingCount';

function actionsWaitingLabel(count: number): string {
  return count === 1 ? '1 action waiting' : `${count} actions waiting`;
}

export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState(0);

  useEffect(() => subscribeConnectivity(setOnline), []);
  useEffect(() => subscribeWaitingCount(setWaiting), []);

  if (online && waiting === 0) return null;

  // Offline → destructive banner; online-with-queue → a calmer "syncing" tone.
  const offlineMessage = waiting > 0
    ? `You're offline — ${actionsWaitingLabel(waiting)}.`
    : "You're offline — we'll refresh when you reconnect.";

  if (!online) {
    return (
      <View
        className="w-full bg-destructive px-4 py-2"
        accessibilityRole="alert"
        accessibilityLabel="You are offline"
      >
        <Text className="text-center text-sm font-medium text-destructiveForeground">
          {offlineMessage}
        </Text>
      </View>
    );
  }

  return (
    <View
      className="w-full bg-muted px-4 py-2"
      accessibilityRole="alert"
      accessibilityLabel={actionsWaitingLabel(waiting)}
    >
      <Text className="text-center text-sm font-medium text-mutedForeground">
        Syncing — {actionsWaitingLabel(waiting)}…
      </Text>
    </View>
  );
}
