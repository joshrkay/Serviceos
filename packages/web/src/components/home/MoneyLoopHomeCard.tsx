import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell, ChevronRight, DollarSign, TrendingUp } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { usePendingProposals } from '../../hooks/usePendingProposals';

interface MoneyDashboardSummary {
  month: string;
  revenueCents: number;
  outstandingCents: number;
  overdueCents: number;
  revenueTrendCents: number;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Solo-owner launch — makes approval inbox + money summary visible from Home
 * without hunting sidebar routes.
 */
export function MoneyLoopHomeCard() {
  const navigate = useNavigate();
  const apiFetch = useApiClient();
  const { count: inboxCount, isLoading: inboxLoading } = usePendingProposals();
  const [summary, setSummary] = useState<MoneyDashboardSummary | null>(null);
  const [moneyLoading, setMoneyLoading] = useState(true);
  const [moneyError, setMoneyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMoneyLoading(true);
    setMoneyError(null);
    apiFetch(`/api/reports/money-dashboard?month=${currentMonth()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as MoneyDashboardSummary);
      })
      .catch((err) => {
        if (!cancelled) {
          setMoneyError(err instanceof Error ? err.message : 'Failed to load');
        }
      })
      .finally(() => {
        if (!cancelled) setMoneyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const trendUp = (summary?.revenueTrendCents ?? 0) >= 0;

  return (
    <section className="px-4 md:px-6 py-4 border-b border-slate-100 bg-gradient-to-b from-slate-50/80 to-transparent">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2.5">
        Money & approvals
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => navigate('/inbox')}
          data-testid="home-inbox-card"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 text-left hover:border-blue-300 hover:shadow-sm transition-all"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50">
            <Bell size={18} className="text-blue-600" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900">Approval inbox</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {inboxLoading
                ? 'Loading…'
                : inboxCount > 0
                  ? `${inboxCount} waiting for your tap`
                  : "Nothing waiting — you're caught up"}
            </p>
          </div>
          {inboxCount > 0 && (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-medium">
              {inboxCount > 9 ? '9+' : inboxCount}
            </span>
          )}
          <ChevronRight size={16} className="text-slate-300 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/reports/money')}
          data-testid="home-money-card"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-4 text-left hover:border-amber-300 hover:shadow-sm transition-all"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-50">
            <DollarSign size={18} className="text-amber-700" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900">Money summary</p>
            {moneyLoading ? (
              <p className="text-xs text-slate-500 mt-0.5">Loading…</p>
            ) : moneyError ? (
              <p className="text-xs text-red-600 mt-0.5">Could not load summary</p>
            ) : summary ? (
              <>
                <p className="text-xs text-slate-600 mt-0.5">
                  {formatCents(summary.revenueCents)} collected this month
                  {summary.revenueTrendCents !== 0 && (
                    <span className={trendUp ? ' text-green-600' : ' text-red-600'}>
                      {' '}
                      ({trendUp ? '+' : ''}
                      {formatCents(summary.revenueTrendCents)} vs last month)
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-1 flex items-center gap-1">
                  <TrendingUp size={10} className="text-amber-600" />
                  {formatCents(summary.outstandingCents)} outstanding
                  {summary.overdueCents > 0 && (
                    <span className="text-red-600 font-medium">
                      · {formatCents(summary.overdueCents)} overdue
                    </span>
                  )}
                </p>
              </>
            ) : (
              <p className="text-xs text-slate-500 mt-0.5">View revenue and exports</p>
            )}
          </div>
          <ChevronRight size={16} className="text-slate-300 shrink-0" />
        </button>
      </div>
    </section>
  );
}
