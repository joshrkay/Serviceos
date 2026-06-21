import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { TrendingUp, TrendingDown, Minus, DollarSign, Wallet, ArrowRight } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { StatCard } from '../ui';
import { formatCurrency } from '../../utils/currency';

/**
 * Epic 12.4 — Core KPIs card.
 *
 * The owner's key numbers at a glance: revenue this month with a
 * month-over-month comparison, and outstanding receivables (with the overdue
 * slice). Reads the existing GET /api/reports/money-dashboard rollup and
 * drills into the full money dashboard for the source records.
 *
 * (Jobs-booked is intentionally not shown here — it needs a backend count
 * that lives outside this dashboard's data; tracked separately.)
 */
interface MoneyDashboardSummary {
  month: string;
  revenueCents: number;
  priorMonthRevenueCents: number;
  revenueTrendCents: number;
  outstandingCents: number;
  overdueCents: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Percent change vs the prior month, or null when there's no prior baseline. */
function trendPct(trendCents: number, priorCents: number): number | null {
  if (priorCents <= 0) return null;
  return Math.round((trendCents / priorCents) * 100);
}

export function CoreKpisCard() {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<MoneyDashboardSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch(`/api/reports/money-dashboard?month=${currentMonth()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as MoneyDashboardSummary);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // Match the other home metric bands: never flash a broken/loading state.
  if (isLoading || error || !summary) return null;

  const { revenueCents, priorMonthRevenueCents, revenueTrendCents, outstandingCents, overdueCents } =
    summary;
  const pct = trendPct(revenueTrendCents, priorMonthRevenueCents);
  const up = revenueTrendCents > 0;
  const flat = revenueTrendCents === 0;
  const TrendIcon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const trendText =
    pct === null
      ? 'vs last month'
      : `${up ? '+' : ''}${pct}% vs last month`;

  return (
    <section data-testid="core-kpis" className="px-4 md:px-6 py-5 border-b border-slate-100">
      <div className="mb-2.5 flex items-center justify-between">
        <p className="text-sm text-slate-700">Your numbers this month</p>
        <button
          onClick={() => navigate('/reports/money')}
          className="flex items-center gap-0.5 text-xs text-blue-600 transition-colors hover:text-blue-700"
        >
          Money dashboard <ArrowRight size={11} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => navigate('/reports/money')}
          className="rounded-2xl text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <StatCard
            className="h-full"
            tone="success"
            label="Revenue"
            value={formatCurrency(revenueCents)}
            hint={
              <span
                data-testid="kpi-revenue-trend"
                className={`flex items-center gap-1 ${
                  flat ? 'text-slate-400' : up ? 'text-green-600' : 'text-red-600'
                }`}
              >
                <TrendIcon size={11} /> {trendText}
              </span>
            }
            icon={<DollarSign size={16} />}
          />
        </button>
        <button
          type="button"
          onClick={() => navigate('/reports/money')}
          data-testid="kpi-outstanding"
          className="rounded-2xl text-left transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <StatCard
            className="h-full"
            tone={overdueCents > 0 ? 'warning' : 'neutral'}
            label="Outstanding"
            value={formatCurrency(outstandingCents)}
            hint={overdueCents > 0 ? `${formatCurrency(overdueCents)} overdue` : 'receivables'}
            icon={<Wallet size={16} />}
          />
        </button>
      </div>
    </section>
  );
}
