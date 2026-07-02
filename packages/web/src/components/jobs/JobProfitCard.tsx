/**
 * Sweep-2 S4 — compact job-costing card for JobDetail.
 *
 * Wires the previously-unconsumed GET /api/reports/job-profit/:jobId
 * (revenue − labor − materials − expenses, integer cents) into the job
 * detail page. Follows the shared ProfitCard convention: the card hides
 * itself entirely when the endpoint is unavailable (404/503) or the
 * viewer lacks invoices:view (403) — it never renders an error state.
 */
import { useEffect, useState } from 'react';
import { DollarSign } from 'lucide-react';
import { apiFetch } from '../../utils/api-fetch';
import { formatCurrency } from '../../utils/currency';

/** Single-job P&L shape returned by the API (api: jobs/job-profit.ts). */
export interface JobProfit {
  revenueCents: number;
  /** Null when the tenant has no labor rate set (laborUnpriced: true). */
  laborCents: number | null;
  laborMinutes: number;
  materialsCents: number;
  expensesCents: number;
  marginCents: number;
  /** Null when revenue is 0 (percentage undefined). */
  marginPct: number | null;
  laborUnpriced: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: JobProfit }
  | { status: 'unavailable' };

export function JobProfitCard({ jobId }: { jobId: string }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    (async () => {
      try {
        const res = await apiFetch(`/api/reports/job-profit/${jobId}`);
        if (!res.ok) {
          if (!cancelled) setLoad({ status: 'unavailable' });
          return;
        }
        const body = (await res.json()) as { data?: JobProfit };
        if (!cancelled) {
          setLoad(body.data ? { status: 'ready', data: body.data } : { status: 'unavailable' });
        }
      } catch {
        if (!cancelled) setLoad({ status: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Loading renders nothing too — the card pops in only when there is real
  // data, so a 404/503/403 never leaves a placeholder behind.
  if (load.status !== 'ready') return null;
  const data = load.data;

  return (
    <div className="rounded-xl bg-card border border-border overflow-hidden" data-testid="job-profit-card">
      <div className="px-4 py-4">
        <div className="flex items-center gap-2 mb-3">
          <DollarSign size={13} className="text-muted-foreground" />
          <h4 className="text-foreground">Job costing</h4>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Revenue" value={formatCurrency(data.revenueCents)} testId="job-profit-revenue" />
          <Metric
            label="Margin"
            value={formatCurrency(data.marginCents)}
            sub={data.marginPct !== null ? `${data.marginPct}%` : undefined}
            negative={data.marginCents < 0}
            testId="job-profit-margin"
          />
          <Metric
            label="Labor"
            value={data.laborCents !== null ? formatCurrency(data.laborCents) : '—'}
            muted
            testId="job-profit-labor"
          />
          <Metric
            label="Materials + expenses"
            value={formatCurrency(data.materialsCents + data.expensesCents)}
            muted
            testId="job-profit-materials"
          />
        </div>
        {data.laborUnpriced && (
          <p className="mt-2 text-xs text-warning" data-testid="job-profit-labor-unpriced">
            Labor is excluded — set a labor rate in Settings for a full margin.
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  muted,
  negative,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  negative?: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm ${muted ? 'text-muted-foreground' : negative ? 'text-destructive' : 'text-foreground'}`}>
        {value}
        {sub && <span className="text-xs text-muted-foreground ml-1">{sub}</span>}
      </p>
    </div>
  );
}
