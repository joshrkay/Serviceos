import { Text } from 'react-native';
import { ScreenShell } from '../src/components/ScreenShell';

export default function Notifications() {
  return (
    <ScreenShell title="Notifications" subtitle="Alerts and reminders">
      <Text className="text-base text-mutedForeground">
        Push notifications for approvals, messages, and end-of-day digests will appear here.
      </Text>
    </ScreenShell>
  );
}
