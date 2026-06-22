/**
 * U10 — per-category notification toggles for Settings. Default-on; tapping a
 * row mutes/unmutes that push category via `useNotificationPreferences`. Rows
 * are ≥44px (`min-h-11`) tap targets and use the accessibility `switch` role so
 * screen readers announce on/off state.
 */
import { Pressable, Text, View } from 'react-native';
import { NOTIFICATION_TYPES } from '@ai-service-os/shared';
import {
  NOTIFICATION_LABELS,
  useNotificationPreferences,
} from '../hooks/useNotificationPreferences';

export function NotificationPreferencesSection({ className }: { className?: string }) {
  const { preferences, error, setPreference } = useNotificationPreferences();

  return (
    <View className={className}>
      <Text className="text-base font-medium text-foreground">Notifications</Text>
      <Text className="mt-1 text-sm text-mutedForeground">
        Choose which alerts this app sends you. All on by default.
      </Text>
      {error ? <Text className="mt-1 text-sm text-destructive">{error}</Text> : null}

      <View className="mt-3 rounded-lg border border-border">
        {NOTIFICATION_TYPES.map((type) => {
          const enabled = preferences[type];
          return (
            <Pressable
              key={type}
              accessibilityRole="switch"
              accessibilityState={{ checked: enabled }}
              accessibilityLabel={NOTIFICATION_LABELS[type]}
              onPress={() => void setPreference(type, !enabled)}
              className="min-h-11 flex-row items-center justify-between border-b border-border px-4 py-3"
            >
              <Text className="text-base text-foreground">{NOTIFICATION_LABELS[type]}</Text>
              <View
                className={`h-6 w-11 justify-center rounded-full px-0.5 ${
                  enabled ? 'items-end bg-primary' : 'items-start bg-muted'
                }`}
              >
                <View className="h-5 w-5 rounded-full bg-background" />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
