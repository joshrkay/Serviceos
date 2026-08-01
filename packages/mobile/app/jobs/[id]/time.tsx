import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { clockTimeEntry } from '../../../src/api/jobs';
import { SecondaryButton } from '../../../src/components/Buttons';
import { ScreenShell } from '../../../src/components/ScreenShell';
import { SavePhaseButton } from '../../../src/components/SavePhaseButton';
import { useSavePhase } from '../../../src/hooks/useSavePhase';
import { useApiClient } from '../../../src/lib/useApiClient';

export default function JobTime() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const api = useApiClient();
  const clockIn = useSavePhase();
  const clockOut = useSavePhase();

  const onClockIn = () => {
    if (!id) return;
    void clockIn.run(async () => {
      await clockTimeEntry(api, id, 'clock_in');
    });
  };

  const onClockOut = () => {
    if (!id) return;
    void clockOut.run(async () => {
      await clockTimeEntry(api, id, 'clock_out');
    });
  };

  return (
    <ScreenShell title="Time on site" backLabel="‹ Job">
      <Text className="mb-6 text-base text-mutedForeground">
        Clock in when you arrive and clock out when you leave. Time entries sync to payroll.
      </Text>
      <View className="gap-4">
        <SavePhaseButton
          phase={clockIn.phase}
          error={clockIn.error}
          idleLabel="Clock in"
          savingLabel="Clocking in…"
          savedLabel="Clocked in"
          onPress={onClockIn}
        />
        <SavePhaseButton
          phase={clockOut.phase}
          error={clockOut.error}
          idleLabel="Clock out"
          savingLabel="Clocking out…"
          savedLabel="Clocked out"
          onPress={onClockOut}
        />
        <SecondaryButton
          label="Reset"
          onPress={() => {
            clockIn.reset();
            clockOut.reset();
          }}
        />
      </View>
    </ScreenShell>
  );
}
