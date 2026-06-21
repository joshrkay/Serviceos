import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents, formatShortDate } from '../src/lib/format';

// Matches GET /api/invoices: invoiceNumber + nested totals.totalCents.
interface Invoice {
  id: string;
  invoiceNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  dueDate?: string;
}

export default function Invoices() {
  const { data, isLoading, error, refetch } = useListQuery<Invoice>('/api/invoices');

  return (
    <EntityList
      title="Invoices"
      data={data}
      isLoading={isLoading}
      error={error}
      onRefresh={() => void refetch()}
      keyOf={(inv) => inv.id}
      renderRow={(inv) => {
        const cents = inv.totals?.totalCents ?? 0;
        const status = inv.status ? inv.status[0].toUpperCase() + inv.status.slice(1) : undefined;
        return {
          primary: `${inv.invoiceNumber ?? `#${inv.id.slice(0, 8)}`} · ${formatMoneyCents(cents)}`,
          secondary: [status, inv.dueDate ? `due ${formatShortDate(inv.dueDate)}` : undefined]
            .filter(Boolean)
            .join(' · '),
        };
      }}
      emptyText="No invoices yet."
    />
  );
}
