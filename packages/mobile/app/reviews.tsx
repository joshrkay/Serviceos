import { Text } from 'react-native';
import { ScreenShell } from '../src/components/ScreenShell';

export default function Reviews() {
  return (
    <ScreenShell title="Reviews" subtitle="Customer feedback">
      <Text className="text-base text-mutedForeground">
        Google and in-app review requests will show up here. Review monitoring coming soon.
      </Text>
    </ScreenShell>
  );
}
