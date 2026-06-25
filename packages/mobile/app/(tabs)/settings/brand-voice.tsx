import { Text } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';

export default function BrandVoiceSettings() {
  return (
    <SettingsSubPage title="Brand voice" subtitle="Tone and messaging style">
      <Text className="text-base text-mutedForeground">
        Set how your business sounds in customer-facing messages and AI drafts.
      </Text>
    </SettingsSubPage>
  );
}
