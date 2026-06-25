import { Text } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';

export default function LanesSettings() {
  return (
    <SettingsSubPage title="Proposal lanes" subtitle="Confidence and auto-approve">
      <Text className="text-base text-mutedForeground">
        Configure confidence thresholds and routing for AI proposals. Lane editing coming soon.
      </Text>
    </SettingsSubPage>
  );
}
