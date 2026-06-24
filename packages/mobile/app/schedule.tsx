import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatShortDate } from '../src/lib/format';

interface Appointment {
  id: string;
  scheduledStart?: string;
  status?: string;
  appointmentType?: string;
}

type ScheduleView = 'list' | 'day' | 'week' | 'map';

function titleCase(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export default function Schedule() {
  const [view, setView] = useState<ScheduleView>('list');
  const { data, isLoading, error, refetch } = useListQuery<Appointment>('/api/appointments', {
    params: { paginated: 'true' },
  });

  const sorted = useMemo(
    () =>
      [...data].sort((a, b) =>
        (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''),
      ),
    [data],
  );

  const headerAction = (
    <View className="flex-row gap-1">
      {(['list', 'day', 'week', 'map'] as ScheduleView[]).map((v) => (
        <Pressable
          key={v}
          accessibilityRole="button"
          accessibilityLabel={`${v} view`}
          onPress={() => setView(v)}
          className={`min-h-11 items-center justify-center rounded-md px-2 ${
            view === v ? 'bg-primary' : 'bg-secondary'
          }`}
        >
          <Text className={`text-xs capitalize ${view === v ? 'text-primaryForeground' : 'text-secondaryForeground'}`}>
            {v}
          </Text>
        </Pressable>
      ))}
    </View>
  );

  if (view === 'map') {
    return (
      <View className="flex-1 bg-background pt-16 pb-20">
        <View className="px-6">
          <Text className="font-heading text-2xl font-semibold text-foreground">Schedule</Text>
          <View className="mt-4">{headerAction}</View>
          <Text className="mt-6 text-base text-mutedForeground">
            Map view shows today&apos;s route order. Pull to refresh on List view for latest jobs.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <EntityList
      title="Schedule"
      data={sorted}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      renderRow={(a) => ({
        primary: a.scheduledStart ? formatShortDate(a.scheduledStart) : 'Appointment',
        secondary: [titleCase(a.appointmentType), titleCase(a.status)].filter(Boolean).join(' · '),
      })}
      emptyText="Nothing scheduled."
      headerAction={headerAction}
    />
  );
}
