import { Text } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';

export default function LeadSourcesSettings() {
  return (
    <SettingsSubPage title="Lead sources" subtitle="Attribution config">
      <Text className="text-base text-mutedForeground">
        Track where leads come from — Google, referrals, yard signs, and more. Configuration coming soon.
      </Text>
    </SettingsSubPage>
  );
}
