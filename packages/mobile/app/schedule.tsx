import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { AppointmentActionSheet, type ActionableAppointment } from '../src/components/AppointmentActionSheet';
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
  /** Optimistic-concurrency token for reschedule/reassign/crew mints. */
  updatedAt?: string;
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
 * assigned day spine — instead of the tenant-wide appointments list. Tapping a
 * row opens the per-appointment action sheet (confirm / reschedule / reassign /
 * crew / cancel); the header "Book" opens manual booking.
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

  const [active, setActive] = useState<ActionableAppointment | null>(null);

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
    <>
      <EntityList
        title="Schedule"
        data={sorted}
        isLoading={isLoading}
        error={error}
        onRefresh={() => void refetch()}
        keyOf={(a) => a.id}
        headerAction={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Book appointment"
            onPress={() => router.push('/appointments/new')}
            className="min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2"
          >
            <Text className="text-base font-semibold text-primaryForeground">Book</Text>
          </Pressable>
        }
        onPressRow={(a) =>
          setActive({
            id: a.id,
            updatedAt: a.updatedAt,
            scheduledStart: a.scheduledStart,
            status: a.status,
          })
        }
        renderRow={(a) => ({
          primary: a.scheduledStart ? formatShortDate(a.scheduledStart, me?.timezone) : 'Appointment',
          secondary: [titleCase(a.appointmentType), titleCase(a.status)].filter(Boolean).join(' · '),
        })}
        emptyText="Nothing scheduled."
      />
      {active ? (
        <AppointmentActionSheet
          visible
          appointment={active}
          timezone={me?.timezone}
          onClose={() => setActive(null)}
          onDone={() => void refetch()}
        />
      ) : null}
    </>
  );
}
