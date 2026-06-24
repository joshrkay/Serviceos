import { Text } from 'react-native';
import { SettingsSubPage } from '../../../src/components/SettingsSubPage';

export default function VoiceSettings() {
  return (
    <SettingsSubPage title="Voice settings" subtitle="Assistant and capture">
      <Text className="text-base text-mutedForeground">
        Voice capture, transcription, and assistant preferences will be configurable here.
      </Text>
    </SettingsSubPage>
  );
}
