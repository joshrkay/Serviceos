import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '../../utils/api-fetch';
import { formatCurrency } from '../../utils/currency';
import { Badge, Spinner } from '../ui';

/**
 * US-069 — customer records panel.
 *
 * Surfaces the customer's Jobs / Estimates / Invoices (the PRD's tabs) plus a
 * lifetime-revenue figure, all scoped to one customer via the `?customerId=`
 * list filters. Invoices rely on the customerId→jobIds translation added to the
 * invoices list route; jobs and estimates already supported the filter.
 * Messages live in the separate CommunicationTimeline; Equipment (P1) has no
 * backing table yet, so it is intentionally omitted.
 */

type Tab = 'jobs' | 'estimates' | 'invoices';

interface RecordRow {
  id: string;
  title: string;
  subtitle?: string;
  status?: string;
  amountCents?: number;
  href: string;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'jobs', label: 'Jobs' },
  { key: 'estimates', label: 'Estimates' },
  { key: 'invoices', label: 'Invoices' },
];

function endpointFor(tab: Tab, customerId: string): string {
  const q = encodeURIComponent(customerId);
  if (tab === 'jobs') return `/api/jobs?customerId=${q}`;
  if (tab === 'estimates') return `/api/estimates?customerId=${q}`;
  return `/api/invoices?customerId=${q}`;
}

// List endpoints return either a bare array or a `{ data }` envelope; normalize
// both so the panel is agnostic to whether the route paginates.
function extractList(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function toRows(tab: Tab, raw: unknown): RecordRow[] {
  return extractList(raw).map((r) => {
    const id = String(r.id ?? '');
    const totals = r.totals as { totalCents?: number } | undefined;
    if (tab === 'jobs') {
      return {
        id,
        title: (r.summary as string) || (r.title as string) || 'Job',
        subtitle: r.scheduledStart
          ? new Date(r.scheduledStart as string).toLocaleDateString()
          : undefined,
        status: r.status as string | undefined,
        href: `/jobs/${id}`,
      };
    }
    if (tab === 'estimates') {
      return {
        id,
        title: (r.estimateNumber as string) || 'Estimate',
        status: r.status as string | undefined,
        amountCents: totals?.totalCents,
        href: `/estimates/${id}`,
      };
    }
    return {
      id,
      title: (r.invoiceNumber as string) || 'Invoice',
      status: r.status as string | undefined,
      amountCents: totals?.totalCents,
      href: `/invoices/${id}`,
    };
  });
}

export function CustomerRecordsPanel({ customerId }: { customerId: string }) {
  const [tab, setTab] = useState<Tab>('jobs');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revenueCents, setRevenueCents] = useState<number | null>(null);

  // Lifetime-revenue badge — best-effort. The rollup endpoint may 503 when the
  // report isn't available; the badge then simply does not render.
  useEffect(() => {
    let active = true;
    apiFetch(`/api/reports/customer-profit/${encodeURIComponent(customerId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (active && body?.data && typeof body.data.revenueCents === 'number') {
          setRevenueCents(body.data.revenueCents);
        }
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  const load = useCallback(
    async (which: Tab) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(endpointFor(which, customerId));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setRows(toRows(which, await res.json()));
      } catch (err) {
        setRows([]);
        setError(err instanceof Error ? err.message : 'Failed to load records');
      } finally {
        setLoading(false);
      }
    },
    [customerId],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  return (
    <div className="flex flex-col gap-3" data-testid="customer-records-panel">
      {revenueCents !== null && (
        <div className="flex items-center justify-between rounded-xl border border-border bg-secondary/40 px-3.5 py-2.5">
          <span className="text-sm text-muted-foreground">Total revenue</span>
          <span
            className="text-sm font-semibold text-foreground tabular-nums"
            data-testid="customer-total-revenue"
          >
            {formatCurrency(revenueCents)}
          </span>
        </div>
      )}

      <div className="flex gap-2" role="tablist" aria-label="Customer records">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-full border px-3.5 py-1.5 text-xs transition-colors ${
              tab === t.key
                ? 'bg-primary border-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:border-border'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && rows.length === 0 && (
        <div className="flex justify-center py-6">
          <Spinner size="sm" className="text-foreground" label="Loading records" />
        </div>
      )}
      {error && !(isLoading && rows.length === 0) && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!(isLoading && rows.length === 0) && !error && rows.length === 0 && (
        <p className="py-4 text-sm text-muted-foreground">
          No {tab} for this customer yet.
        </p>
      )}
      {!(isLoading && rows.length === 0) && !error && rows.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to={row.href}
                className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:border-primary/40 hover:bg-secondary/30"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{row.title}</span>
                  {row.subtitle && (
                    <span className="block text-xs text-muted-foreground">{row.subtitle}</span>
                  )}
                </span>
                {row.status && (
                  <Badge variant="neutral" className="capitalize">
                    {row.status.replace(/_/g, ' ')}
                  </Badge>
                )}
                {typeof row.amountCents === 'number' && (
                  <span className="text-sm tabular-nums text-foreground">
                    {formatCurrency(row.amountCents)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
