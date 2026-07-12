import { useMemo } from 'react';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { useMe } from '../src/hooks/useMe';
import { formatShortDate } from '../src/lib/format';

interface Appointment {
  id: string;
  scheduledStart?: string;
  status?: string;
  appointmentType?: string;
}

function titleCase(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export default function Schedule() {
  const { me } = useMe();
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

  return (
    <EntityList
      title="Schedule"
      data={sorted}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      renderRow={(a) => ({
        primary: a.scheduledStart ? formatShortDate(a.scheduledStart, me?.timezone) : 'Appointment',
        secondary: [titleCase(a.appointmentType), titleCase(a.status)].filter(Boolean).join(' · '),
      })}
      emptyText="Nothing scheduled."
    />
  );
}
