import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../lib/useApiClient';
import { decodeError } from '../lib/appError';

export interface MoneySummary {
  month: string;
  /** Net revenue collected this month (gross − refunds), integer cents. */
  revenueCents: number;
  outstandingCents: number;
  overdueCents: number;
  /** This month's revenue minus last month's, integer cents (±). */
  revenueTrendCents: number;
}

export interface MoneyDashboardResult {
  summary: MoneySummary | null;
  isLoading: boolean;
  error: string | null;
  /** API returned 503 NOT_CONFIGURED — the caller hides the money card. */
  notConfigured: boolean;
}

/** Tenant-local month is a later refinement; UTC matches the web home card. */
function currentMonth(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Fetches GET /api/reports/money-dashboard for the current month — the Home
 * "This month" pulse (revenue + trend, outstanding, overdue). Mirrors web's
 * MoneyLoopHomeCard fetch with the read-screen request-version de-dup +
 * AbortError-as-non-error, and degrades gracefully when the report repo is
 * unconfigured (503) so Home still renders without money.
 */
export function useMoneyDashboard(): MoneyDashboardResult {
  const api = useApiClient();
  const [summary, setSummary] = useState<MoneySummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const versionRef = useRef(0);

  const load = useCallback(async () => {
    const myVersion = ++versionRef.current;
    setIsLoading(true);
    setError(null);
    // Reset per-load so a stale 503 can't leave the card hidden once the report
    // repo comes online — even if this load ends in the error path.
    setNotConfigured(false);
    try {
      const res = await api(`/api/reports/money-dashboard?month=${currentMonth()}`);
      if (myVersion !== versionRef.current) return;
      if (res.status === 503) {
        setSummary(null); // drop any prior summary; the report is unconfigured
        setNotConfigured(true);
        return;
      }
      if (!res.ok) throw new Error((await decodeError(res)).message);
      const body = (await res.json()) as { data?: MoneySummary };
      if (myVersion !== versionRef.current) return;
      setSummary(body.data ?? null);
    } catch (err) {
      if (myVersion !== versionRef.current) return;
      if (err instanceof Error && err.name === 'AbortError') return; // cancelled on sign-out
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (myVersion === versionRef.current) setIsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return { summary, isLoading, error, notConfigured };
}
