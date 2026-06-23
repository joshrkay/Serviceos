import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { ScreenShell } from '../../../src/components/ScreenShell';

export default function JobPhotos() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');

  return (
    <ScreenShell title="Job photos" backLabel="‹ Job" subtitle={`Job ${id.slice(0, 8)}`}>
      <Text className="text-base text-mutedForeground">
        Photo capture and gallery for this job will appear here. Upload from the field coming soon.
      </Text>
    </ScreenShell>
  );
}
