import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents } from '../src/lib/format';
import { estimateStatusBadge } from '../src/lib/entityStatus';

// Matches GET /api/estimates: estimateNumber + nested totals.totalCents +
// lineItems (the customer is NOT joined into the list response, so the row
// leads with the work — the first line item — not the customer name).
interface Estimate {
  id: string;
  estimateNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  lineItems?: { description?: string }[];
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
      renderRow={(e) => {
        const number = e.estimateNumber ?? `#${e.id.slice(0, 8)}`;
        return {
          primary: e.lineItems?.[0]?.description ?? number,
          secondary: number,
          trailing: formatMoneyCents(e.totals?.totalCents ?? 0),
          badge: estimateStatusBadge(e.status),
        };
      }}
      emptyText="No estimates yet."
    />
  );
}
