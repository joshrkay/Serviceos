import { useEffect, useMemo } from 'react';
import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { useMe } from '../src/hooks/useMe';
import { formatShortDate } from '../src/lib/format';
import { navModelFor } from '../src/navigation/personaNav';
import { useRouter } from 'expo-router';

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

/**
 * Supervisor schedule list. Technician accounts redirect to Today — the
 * assigned day spine — instead of the tenant-wide appointments list.
 */
export default function Schedule() {
  const router = useRouter();
  const { me } = useMe();
  // Technician role has no tenant-wide schedule — Today is the assigned day spine.
  // Owners/dispatchers in "both" mode keep the supervisor schedule list.
  const technicianOnly = me
    ? navModelFor({
        role: me.role,
        currentMode: me.current_mode,
        canFieldServe: me.can_field_serve,
      }).persona === 'tech'
    : false;

  useEffect(() => {
    if (technicianOnly) {
      router.replace('/(tabs)/today');
    }
  }, [technicianOnly, router]);

  const { data, isLoading, error, refetch } = useListQuery<Appointment>('/api/appointments', {
    params: { paginated: 'true' },
    enabled: !technicianOnly && Boolean(me),
  });

  const sorted = useMemo(
    () =>
      [...data].sort((a, b) =>
        (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''),
      ),
    [data],
  );

  if (technicianOnly) {
    return null;
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
        primary: a.scheduledStart ? formatShortDate(a.scheduledStart, me?.timezone) : 'Appointment',
        secondary: [titleCase(a.appointmentType), titleCase(a.status)].filter(Boolean).join(' · '),
      })}
      emptyText="Nothing scheduled."
    />
  );
}
