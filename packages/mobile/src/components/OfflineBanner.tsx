/**
 * Persistent "you're offline" banner.
 *
 * Sits above the whole tree (mounted in `app/_layout.tsx`) and is driven by the
 * connectivity layer (`subscribeConnectivity`, backed by NetInfo). When the
 * device drops its connection the banner appears and stays until connectivity
 * returns; on reconnect the read hooks heal themselves via `useReconnectRetry`,
 * so the banner just disappears. Renders nothing while online, so it costs an
 * empty fragment in the common case.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { subscribeConnectivity } from '../lib/connectivity';

export function OfflineBanner() {
  const [online, setOnline] = useState(true);

  useEffect(() => subscribeConnectivity(setOnline), []);

  if (online) return null;

  return (
    <View
      className="w-full bg-destructive px-4 py-2"
      accessibilityRole="alert"
      accessibilityLabel="You are offline"
    >
      <Text className="text-center text-sm font-medium text-destructiveForeground">
        You're offline — we'll refresh when you reconnect.
      </Text>
    </View>
  );
}
