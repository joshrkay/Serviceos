import { Text } from 'react-native';
import { ScreenShell } from '../../src/components/ScreenShell';

export default function EndOfDayDigest() {
  return (
    <ScreenShell title="End of day review" backLabel="‹ Settings" subtitle="Close-out checklist">
      <Text className="text-base text-mutedForeground">
        Review today&apos;s jobs, time entries, and open approvals before you sign off.
      </Text>
    </ScreenShell>
  );
}
