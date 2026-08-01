import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { NotificationType } from '@ai-service-os/shared';
import { useNotificationPreferences } from '../hooks/useNotificationPreferences';

/** Display order + owner-friendly labels for the muteable categories. */
const CATEGORIES: ReadonlyArray<{ type: NotificationType; label: string }> = [
  { type: 'incoming_call', label: 'Incoming calls' },
  { type: 'inbound_sms', label: 'Text messages' },
  { type: 'appointment_reminder', label: 'Appointment reminders' },
  { type: 'appointment_cancellation', label: 'Appointment cancellations' },
  { type: 'payment_received', label: 'Payments received' },
  { type: 'invoice_overdue', label: 'Overdue invoices' },
  { type: 'lead_captured', label: 'New leads' },
  { type: 'escalation', label: 'Escalations' },
  { type: 'emergency', label: 'Emergencies' },
  { type: 'proposal_needs_approval', label: 'Approvals needed' },
  { type: 'proposal_executed', label: 'Completed actions' },
];

/**
 * Settings section: one row per notification category, tap to mute/unmute.
 * Absent preference = on (the opt-out model the API uses). Each row is a ≥44px
 * tap target (`min-h-11`) presented as an accessible switch.
 */
export function NotificationPreferences({ className }: { className?: string }) {
  const { preferences, isLoading, setEnabled } = useNotificationPreferences();
  const loadingFirst = isLoading && Object.keys(preferences).length === 0;

  return (
    <View className={className}>
      <Text className="text-base font-medium text-foreground">Notifications</Text>
      <Text className="mt-1 text-sm text-mutedForeground">
        Choose which alerts reach this device.
      </Text>
      {loadingFirst ? <ActivityIndicator className="mt-3" /> : null}
      <View className="mt-3 rounded-lg border border-border">
        {CATEGORIES.map((c, i) => {
          const enabled = preferences[c.type] ?? true;
          return (
            <Pressable
              key={c.type}
              accessibilityRole="switch"
              accessibilityState={{ checked: enabled }}
              accessibilityLabel={c.label}
              onPress={() => void setEnabled(c.type, !enabled)}
              className={`min-h-11 flex-row items-center justify-between px-4 py-3 ${
                i > 0 ? 'border-t border-border' : ''
              }`}
            >
              <Text className="text-base text-foreground">{c.label}</Text>
              <Text
                className={`text-base font-semibold ${
                  enabled ? 'text-primary' : 'text-mutedForeground'
                }`}
              >
                {enabled ? 'On' : 'Off'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
