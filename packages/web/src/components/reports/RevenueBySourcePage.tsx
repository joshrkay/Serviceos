import { useEffect, useState } from 'react';
import { TrendingUp, BarChart3 } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { Spinner, EmptyState } from '../ui';
import { ErrorState } from '../ErrorState';

/**
 * Revenue-by-source attribution report.
 *
 * Shows aggregated lead → invoice → payment totals grouped by source +
 * UTM campaign, scoped to the configurable date window. Default is the
 * trailing 30 days of payments.
 */

interface RevenueRow {
  source: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  leadCount: number;
  customerCount: number;
  invoicedCents: number;
  paidCents: number;
}

const SOURCE_LABEL: Record<string, string> = {
  web_form: 'Web form',
  phone_call: 'Phone call',
  referral: 'Referral',
  walk_in: 'Walk-in',
  marketplace: 'Marketplace',
  other: 'Other',
  unknown: 'Unattributed',
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function RevenueBySourcePage() {
  const apiFetch = useApiClient();
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [rows, setRows] = useState<RevenueRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the error-state Retry button to re-run the fetch effect.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (from) params.set('from', `${from}T00:00:00.000Z`);
    if (to) params.set('to', `${to}T23:59:59.999Z`);
    apiFetch(`/api/reports/revenue-by-source?${params}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setRows(body.data ?? []);
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
  }, [from, to, apiFetch, reloadKey]);

  const totalPaid = rows.reduce((sum, r) => sum + r.paidCents, 0);
  const totalLeads = rows.reduce((sum, r) => sum + r.leadCount, 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="flex items-center gap-2 mb-1">
          <BarChart3 size={18} className="text-slate-500" />
          <h1 className="text-slate-900" style={{ fontSize: '1.25rem' }}>
            Revenue by source
          </h1>
        </div>
        <p className="text-sm text-slate-500 mb-6">
          Attributed revenue grouped by lead source and UTM campaign.
        </p>

        {/* Date range filter */}
        <div className="flex flex-wrap items-end gap-3 mb-6">
          <div>
            <label className="text-xs text-slate-500 mb-1 block">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 mb-1 block">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-400"
            />
          </div>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs text-slate-500">Total revenue</p>
            <p className="text-lg text-slate-900 mt-1 flex items-center gap-1">
              <TrendingUp size={14} className="text-green-500" /> {formatCents(totalPaid)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs text-slate-500">Attributed leads</p>
            <p className="text-lg text-slate-900 mt-1">{totalLeads}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs text-slate-500">Source buckets</p>
            <p className="text-lg text-slate-900 mt-1">{rows.length}</p>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-xs text-slate-500">
                <th className="text-left px-4 py-2.5">Source</th>
                <th className="text-left px-4 py-2.5">Campaign</th>
                <th className="text-left px-4 py-2.5">Medium</th>
                <th className="text-right px-4 py-2.5">Leads</th>
                <th className="text-right px-4 py-2.5">Customers</th>
                <th className="text-right px-4 py-2.5">Invoiced</th>
                <th className="text-right px-4 py-2.5">Paid</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="py-8">
                    <div className="flex items-center justify-center">
                      <Spinner size="md" className="text-slate-900" label="Loading revenue report" />
                    </div>
                  </td>
                </tr>
              )}
              {!isLoading && error && (
                <tr>
                  <td colSpan={7}>
                    <ErrorState
                      message="Couldn't load the revenue report."
                      onRetry={() => setReloadKey((k) => k + 1)}
                    />
                  </td>
                </tr>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <EmptyState title="No attributed revenue in this period." />
                  </td>
                </tr>
              )}
              {!isLoading && !error && rows.map((r, i) => (
                <tr key={`${r.source}:${r.utmCampaign}:${r.utmSource}:${i}`}
                    className="border-t border-slate-100">
                  <td className="px-4 py-2.5 text-slate-800">
                    {SOURCE_LABEL[r.source] ?? r.source}
                  </td>
                  <td className="px-4 py-2.5 text-slate-700">{r.utmCampaign ?? '—'}</td>
                  <td className="px-4 py-2.5 text-slate-700">{r.utmMedium ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{r.leadCount}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{r.customerCount}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">
                    {formatCents(r.invoicedCents)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-slate-900">
                    {formatCents(r.paidCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
