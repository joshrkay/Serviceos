import { Text } from 'react-native';
import { ScreenShell } from '../../src/components/ScreenShell';

export default function WeeklyDigest() {
  return (
    <ScreenShell title="Weekly digest" backLabel="‹ Settings" subtitle="Owner summary">
      <Text className="text-base text-mutedForeground">
        Your weekly business summary — revenue, jobs booked, and outstanding approvals — will appear here.
      </Text>
    </ScreenShell>
  );
}
