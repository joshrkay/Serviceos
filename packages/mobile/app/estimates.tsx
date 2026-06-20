import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents } from '../src/lib/format';

// Matches GET /api/estimates: estimateNumber + nested totals.totalCents.
interface Estimate {
  id: string;
  estimateNumber?: string;
  totals?: { totalCents?: number };
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
        primary: `${e.estimateNumber ?? `#${e.id.slice(0, 8)}`} · ${formatMoneyCents(e.totals?.totalCents ?? 0)}`,
        secondary: e.status,
      })}
      emptyText="No estimates yet."
    />
  );
}
