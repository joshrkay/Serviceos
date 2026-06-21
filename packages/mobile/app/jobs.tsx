import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { jobRowText, type JobRow } from '../src/lib/jobRow';

export default function Jobs() {
  const { data, isLoading, error, refetch } = useListQuery<JobRow>('/api/jobs');

  return (
    <EntityList
      title="Jobs"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(j) => j.id}
      renderRow={(j) => jobRowText(j)}
      emptyText="No jobs yet."
    />
  );
}
