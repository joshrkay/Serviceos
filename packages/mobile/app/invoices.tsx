import { EntityList } from '../src/components/EntityList';
import { useListQuery } from '../src/hooks/useListQuery';
import { formatMoneyCents, formatShortDate } from '../src/lib/format';

interface Invoice {
  id: string;
  number?: string;
  total_cents?: number;
  totalCents?: number;
  status?: string;
  due_date?: string;
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
        const cents = inv.totalCents ?? inv.total_cents ?? 0;
        const due = inv.dueDate ?? inv.due_date;
        const status = inv.status ? inv.status[0].toUpperCase() + inv.status.slice(1) : undefined;
        return {
          primary: `${inv.number ?? `#${inv.id.slice(0, 8)}`} · ${formatMoneyCents(cents)}`,
          secondary: [status, due ? `due ${formatShortDate(due)}` : undefined].filter(Boolean).join(' · '),
        };
      }}
      emptyText="No invoices yet."
    />
  );
}
