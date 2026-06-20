import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';

interface Job {
  id: string;
  title?: string;
  customer_name?: string;
  customerName?: string;
  status?: string;
}

export default function Jobs() {
  const { data, isLoading, error, refetch } = useListQuery<Job>('/api/jobs');

  return (
    <EntityList
      title="Jobs"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(j) => j.id}
      renderRow={(j) => ({
        primary: j.title ?? j.customerName ?? j.customer_name ?? `Job ${j.id.slice(0, 8)}`,
        secondary: j.status,
      })}
      emptyText="No jobs yet."
    />
  );
}
