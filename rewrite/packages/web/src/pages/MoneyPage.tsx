import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatCents } from '../lib/api';

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-stone-200 text-stone-600',
  sent: 'bg-blue-100 text-blue-800',
  paid: 'bg-emerald-100 text-emerald-800',
  overdue: 'bg-red-100 text-red-800',
  void: 'bg-stone-200 text-stone-500',
};

export default function MoneyPage() {
  const queryClient = useQueryClient();
  const summary = useQuery({
    queryKey: ['money-summary'],
    queryFn: async () => {
      const result = await api.reports.moneySummary();
      if (result.status !== 200) throw new Error('failed');
      return result.body;
    },
    refetchInterval: 5_000,
  });
  const invoices = useQuery({
    queryKey: ['invoices'],
    queryFn: async () => {
      const result = await api.invoices.list();
      if (result.status !== 200) throw new Error('failed');
      return result.body.invoices;
    },
    refetchInterval: 5_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['money-summary'] });
  };
  const send = useMutation({
    mutationFn: (id: string) => api.invoices.send({ params: { id }, body: {} }),
    onSettled: invalidate,
  });
  const recordPayment = useMutation({
    mutationFn: ({ id, amountCents }: { id: string; amountCents: number }) =>
      api.invoices.recordPayment({
        params: { id },
        body: { amountCents, method: 'cash' },
      }),
    onSettled: invalidate,
  });

  const cards = [
    { label: 'Outstanding', value: summary.data?.outstandingCents, tone: 'text-stone-900' },
    { label: 'Paid (30 days)', value: summary.data?.paidLast30DaysCents, tone: 'text-emerald-600' },
    { label: 'Overdue', value: summary.data?.overdueCents, tone: 'text-red-600' },
  ];

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Money</h1>
      <p className="mt-1 text-sm text-stone-500">Time to cash, at a glance.</p>

      <div className="mt-6 grid grid-cols-3 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-stone-500">{card.label}</div>
            <div className={`mt-2 text-2xl font-bold ${card.tone}`}>
              {card.value === undefined ? '—' : formatCents(card.value)}
            </div>
          </div>
        ))}
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">Invoices</h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500">
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Items</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(invoices.data ?? []).map((invoice) => (
                <tr key={invoice.id} className="border-b border-stone-100 last:border-b-0">
                  <td className="px-5 py-3 font-medium">{invoice.customerName}</td>
                  <td className="max-w-56 truncate px-5 py-3 text-stone-500">
                    {invoice.lineItems.map((item) => item.description).join(', ')}
                  </td>
                  <td className="px-5 py-3 text-right font-semibold">{formatCents(invoice.totalCents)}</td>
                  <td className="px-5 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[invoice.status] ?? ''}`}
                    >
                      {invoice.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {invoice.status === 'draft' && (
                      <button
                        type="button"
                        onClick={() => send.mutate(invoice.id)}
                        className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-700"
                      >
                        Send
                      </button>
                    )}
                    {(invoice.status === 'sent' || invoice.status === 'overdue') && (
                      <button
                        type="button"
                        onClick={() =>
                          recordPayment.mutate({ id: invoice.id, amountCents: invoice.totalCents })
                        }
                        className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium hover:bg-stone-100"
                      >
                        Record payment
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!invoices.isLoading && (invoices.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-stone-500">
                    No invoices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
