import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents, formatShortDate } from '../src/lib/format';
import { invoiceStatusBadge } from '../src/lib/entityStatus';

// Matches GET /api/invoices: invoiceNumber + nested totals.totalCents +
// lineItems + dueDate. The customer is NOT joined into the list response, so
// the row leads with the work (first line item), not the customer name.
interface Invoice {
  id: string;
  invoiceNumber?: string;
  totals?: { totalCents?: number };
  status?: string;
  dueDate?: string;
  lineItems?: { description?: string }[];
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
        const number = inv.invoiceNumber ?? `#${inv.id.slice(0, 8)}`;
        return {
          primary: inv.lineItems?.[0]?.description ?? number,
          secondary: [number, inv.dueDate ? `due ${formatShortDate(inv.dueDate)}` : undefined]
            .filter(Boolean)
            .join(' · '),
          trailing: formatMoneyCents(inv.totals?.totalCents ?? 0),
          badge: invoiceStatusBadge(inv.status, inv.dueDate),
        };
      }}
      emptyText="No invoices yet."
    />
  );
}
