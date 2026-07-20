/**
 * Persistent "you're offline" banner.
 *
 * Sits above the whole tree (mounted in `app/_layout.tsx`) and is driven by the
 * connectivity layer (`subscribeConnectivity`, backed by NetInfo). When the
 * device drops its connection the banner appears and stays until connectivity
 * returns; on reconnect the read hooks heal themselves via `useReconnectRetry`
 * and the offline queue flushes, so the banner just disappears. While offline
 * it also shows the queue depth (U12) — how many voice notes / approvals are
 * saved and waiting to send. Renders nothing while online, so it costs an
 * empty fragment in the common case.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { subscribeConnectivity } from '../lib/connectivity';
import { getOfflineQueue } from '../offline/queueInstance';

/** Banner copy for the current offline queue depth. */
export function offlineBannerCopy(queueDepth: number): string {
  if (queueDepth <= 0) return "You're offline — we'll refresh when you reconnect.";
  const noun = queueDepth === 1 ? 'action' : 'actions';
  return `You're offline — ${queueDepth} ${noun} saved to send when you reconnect.`;
}

export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [queueDepth, setQueueDepth] = useState(0);

  useEffect(() => subscribeConnectivity(setOnline), []);
  useEffect(() => getOfflineQueue().subscribe((items) => setQueueDepth(items.length)), []);

  if (online) return null;

  return (
    <View
      className="w-full bg-destructive px-4 py-2"
      accessibilityRole="alert"
      accessibilityLabel="You are offline"
    >
      <Text className="text-center text-sm font-medium text-destructiveForeground">
        {offlineBannerCopy(queueDepth)}
      </Text>
    </View>
  );
}
