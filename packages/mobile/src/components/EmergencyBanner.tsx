import { useRouter } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  currentEmergency,
  dismissEmergency,
  subscribeEmergency,
} from '../push/emergencyBanner';
import { routeForNotification } from '../push/notificationRouting';

const COPY: Record<string, { title: string; body: string }> = {
  emergency: {
    title: 'Emergency',
    body: 'A caller reported an emergency. The on-call script is running — review it now.',
  },
  escalation: {
    title: 'Needs you now',
    body: 'A live call was escalated to you.',
  },
};

/**
 * U4 (B7) — high-urgency Home banner for escalation/emergency notifications
 * that arrive while the app is foregrounded (the OS banner is suppressed
 * then). Dismiss is client-local; View deep-links to the notification's
 * target screen via the same allowlisted router as a tray tap.
 */
export function EmergencyBanner() {
  const router = useRouter();
  const alert = useSyncExternalStore(subscribeEmergency, currentEmergency, currentEmergency);
  if (!alert) return null;

  const type = typeof alert.data.type === 'string' ? alert.data.type : 'escalation';
  const copy = COPY[type] ?? COPY.escalation;

  return (
    <View className="mt-4 w-full max-w-full rounded-lg border border-destructive bg-destructive p-4">
      <Text className="text-base font-semibold text-destructiveForeground">⚠ {copy.title}</Text>
      <Text className="mt-1 text-sm text-destructiveForeground">{copy.body}</Text>
      <View className="mt-3 flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View emergency"
          onPress={() => {
            const route = routeForNotification(alert.data);
            dismissEmergency();
            router.push(route);
          }}
          className="min-h-11 flex-1 items-center justify-center rounded-md bg-background px-4 py-3"
        >
          <Text className="text-base font-semibold text-foreground">View</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss emergency"
          onPress={() => dismissEmergency()}
          className="min-h-11 items-center justify-center rounded-md border border-destructiveForeground px-4 py-3"
        >
          <Text className="text-base text-destructiveForeground">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
