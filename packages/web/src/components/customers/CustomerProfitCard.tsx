import { useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { formatCurrency } from '../../utils/currency';

interface CustomerJobProfit {
  jobId: string;
  jobNumber: string;
  summary: string;
  revenueCents: number;
  marginCents: number;
  marginPct: number | null;
}

interface CustomerProfit {
  customerId: string;
  jobCount: number;
  revenueCents: number;
  laborCents: number;
  materialsCents: number;
  expensesCents: number;
  marginCents: number;
  marginPct: number | null;
  laborUnpriced: boolean;
  jobs: CustomerJobProfit[];
}

/**
 * Customer profitability (P&L) summary — revenue, costs, and margin rolled up
 * across the customer's jobs. Backs GET /api/reports/customer-profit/:id; the
 * report is hidden when it isn't configured (503) so it never shows an error
 * on a tenant without the billing repos wired.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: CustomerProfit }
  | { status: 'unavailable' };

export function CustomerProfitCard({ customerId }: { customerId: string }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`/api/reports/customer-profit/${customerId}`);
        if (!res.ok) {
          if (!cancelled) setLoad({ status: 'unavailable' });
          return;
        }
        const body = (await res.json()) as { data: CustomerProfit };
        if (!cancelled) setLoad({ status: 'ready', data: body.data });
      } catch {
        if (!cancelled) setLoad({ status: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  if (load.status === 'unavailable') return null;
  const data = load.status === 'ready' ? load.data : null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm text-slate-800">Profitability</h3>
        {data && (
          <span className="text-xs text-slate-400">
            {data.jobCount} {data.jobCount === 1 ? 'job' : 'jobs'}
          </span>
        )}
      </div>

      {!data ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Revenue" value={formatCurrency(data.revenueCents)} />
            <Metric
              label="Margin"
              value={formatCurrency(data.marginCents)}
              sub={data.marginPct !== null ? `${data.marginPct}%` : undefined}
              positive={data.marginCents >= 0}
            />
            <Metric label="Labor" value={formatCurrency(data.laborCents)} muted />
            <Metric
              label="Materials + expenses"
              value={formatCurrency(data.materialsCents + data.expensesCents)}
              muted
            />
          </div>
          {data.laborUnpriced && (
            <p className="mt-2 text-xs text-amber-600">
              Labor is excluded — set a labor rate in Settings for a full margin.
            </p>
          )}
          {data.jobs.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-2 flex flex-col gap-1.5">
              {data.jobs.slice(0, 5).map((j) => (
                <div key={j.jobId} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-slate-500 truncate">{j.jobNumber} · {j.summary}</span>
                  <span className={j.marginCents >= 0 ? 'text-slate-700' : 'text-red-600'}>
                    {formatCurrency(j.marginCents)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  muted,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  positive?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p
        className={`text-sm ${
          muted ? 'text-slate-600' : positive === false ? 'text-red-600' : 'text-slate-900'
        }`}
      >
        {value}
        {sub && <span className="text-xs text-slate-400 ml-1">{sub}</span>}
      </p>
    </div>
  );
}
