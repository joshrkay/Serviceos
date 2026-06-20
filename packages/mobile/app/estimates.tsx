import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents } from '../src/lib/format';

interface Estimate {
  id: string;
  number?: string;
  total_cents?: number;
  totalCents?: number;
  status?: string;
}

export default function Estimates() {
  const { data, isLoading, error, refetch } = useListQuery<Estimate>('/api/estimates');

  return (
    <EntityList
      title="Estimates"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(e) => e.id}
      renderRow={(e) => ({
        primary: `${e.number ?? `#${e.id.slice(0, 8)}`} · ${formatMoneyCents(e.totalCents ?? e.total_cents ?? 0)}`,
        secondary: e.status,
      })}
      emptyText="No estimates yet."
    />
  );
}
