import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { LabelValueTable } from '../../src/components/LabelValueTable';
import { ScreenShell } from '../../src/components/ScreenShell';

export default function CallDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');

  return (
    <ScreenShell title="Call detail" backLabel="‹ Calls">
      <Text className="mb-4 text-base text-mutedForeground">
        Call recording and transcript will appear here when available.
      </Text>
      <LabelValueTable rows={[{ label: 'Call ID', value: id }]} />
    </ScreenShell>
  );
}
