import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatShortDate } from '../src/lib/format';

// Appointment payload from GET /api/appointments (Dates serialize to ISO).
// Appointments route via job→customer, so no customer name is on this shape.
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
  // `paginated=true` is required: GET /api/appointments with no jobId and no
  // pagination/filter param returns 400 (legacy contract in routes/appointments.ts).
  const { data, isLoading, error, refetch } = useListQuery<Appointment>('/api/appointments', {
    params: { paginated: 'true' },
  });

  return (
    <EntityList
      title="Schedule"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      renderRow={(a) => ({
        primary: a.scheduledStart ? formatShortDate(a.scheduledStart) : 'Appointment',
        secondary: [titleCase(a.appointmentType), titleCase(a.status)].filter(Boolean).join(' · '),
      })}
      emptyText="Nothing scheduled."
    />
  );
}
