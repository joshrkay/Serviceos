import { useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';
import { Spinner } from '../ui';
import { ErrorState } from '../ErrorState';

interface MoneyDashboardSummary {
  month: string;
  revenueCents: number;
  priorMonthRevenueCents: number;
  revenueTrendCents: number;
  expensesCents: number;
  outstandingCents: number;
  overdueCents: number;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(cents / 100).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })}`;
}

/** Current UTC month as 'YYYY-MM'. */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First and last day of a 'YYYY-MM' month as ISO dates, for the export range. */
function monthRange(month: string): { from: string; to: string } {
  const [year, mon] = month.split('-').map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 10);
  return { from, to };
}

export function MoneyDashboardPage() {
  const apiFetch = useApiClient();
  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<MoneyDashboardSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the error-state Retry button to re-run the fetch effect.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch(`/api/reports/money-dashboard?month=${month}`)
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
  }, [month, apiFetch, reloadKey]);

  async function downloadExport() {
    const { from, to } = monthRange(month);
    const res = await apiFetch(`/api/reports/tax-export?from=${from}&to=${to}`);
    if (!res.ok) {
      setError(`Export failed: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tax-export-${from}-to-${to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const trendUp = (summary?.revenueTrendCents ?? 0) >= 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Money</h1>
            <p className="text-sm text-slate-500">
              This month's revenue, what's outstanding, and what's overdue.
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div>
              <label className="block text-xs text-slate-500 mb-1">Month</label>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value || currentMonth())}
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
              />
            </div>
            <button
              type="button"
              onClick={downloadExport}
              className="rounded-lg bg-slate-900 text-white text-sm px-3 py-2 hover:bg-slate-700"
            >
              Export for taxes (CSV)
            </button>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" className="text-slate-900" label="Loading money dashboard" />
          </div>
        )}
        {error && (
          <ErrorState
            message="Couldn't load the money dashboard."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        )}

        {!isLoading && !error && summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Revenue</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">
                {formatCents(summary.revenueCents)}
              </p>
              <p className={`text-xs mt-1 ${trendUp ? 'text-green-600' : 'text-red-600'}`}>
                {trendUp ? '▲' : '▼'} {formatCents(summary.revenueTrendCents)} vs. last month
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Expenses</p>
              <p className="text-xl font-semibold text-slate-900 mt-1">
                {formatCents(summary.expensesCents)}
              </p>
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
              <p className="text-xs text-amber-700 uppercase tracking-wide">Outstanding</p>
              <p className="text-xl font-semibold text-amber-900 mt-1">
                {formatCents(summary.outstandingCents)}
              </p>
            </div>
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3.5">
              <p className="text-xs text-red-700 uppercase tracking-wide">Overdue</p>
              <p className="text-xl font-semibold text-red-900 mt-1">
                {formatCents(summary.overdueCents)}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
