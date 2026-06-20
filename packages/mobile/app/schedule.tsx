import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatShortDate } from '../src/lib/format';

interface Appointment {
  id: string;
  title?: string;
  customer_name?: string;
  customerName?: string;
  start_time?: string;
  startTime?: string;
}

export default function Schedule() {
  const { data, isLoading, error, refetch } = useListQuery<Appointment>('/api/appointments');

  return (
    <EntityList
      title="Schedule"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(a) => a.id}
      renderRow={(a) => {
        const start = a.startTime ?? a.start_time;
        return {
          primary: a.title ?? a.customerName ?? a.customer_name ?? 'Appointment',
          secondary: start ? formatShortDate(start) : undefined,
        };
      }}
      emptyText="Nothing scheduled."
    />
  );
}
