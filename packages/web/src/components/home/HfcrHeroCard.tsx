import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { formatCurrency } from '../../utils/currency';

/**
 * HFCR hero tile — the v1 wedge's single owner-facing number: money the
 * business collected this month WITHOUT the owner ever opening the app.
 *
 * Deliberately ONE number, no chart, no dashboard (PRD §9: the data is for
 * the model + investors; the owner gets a hero number + weekly SMS). The
 * empty state IS the onboarding payoff — it frames the first hands-free
 * dollar / first recovered call as the moment to wait for.
 *
 * Renders nothing while loading or on error (a hero number must never flash a
 * broken state); reappears once the metric resolves.
 */
interface HfcrSummary {
  month: string;
  hfcrCents: number;
  handsFreeInvoiceCount: number;
  recoveredCallCount: number;
  consideredPaymentCount: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function HfcrHeroCard() {
  const apiFetch = useApiClient();
  const [summary, setSummary] = useState<HfcrSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    apiFetch(`/api/reports/hfcr?month=${currentMonth()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!cancelled) setSummary(body.data as HfcrSummary);
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

  // Never show a broken/loading hero — the number is the whole point.
  if (isLoading || error || !summary) return null;

  const { hfcrCents, recoveredCallCount } = summary;

  if (hfcrCents <= 0) {
    // Onboarding payoff: set the goal rather than showing a deflating $0.
    return (
      <section data-testid="hfcr-hero" className="px-4 md:px-6 py-5 border-b border-slate-100">
        <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/60 px-5 py-5">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 flex items-center gap-1.5">
            <Sparkles size={13} /> Hands-free collected
          </p>
          <p className="mt-1.5 text-sm text-emerald-800">
            Your first hands-free dollar will land here — collected while you never opened the app.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="hfcr-hero" className="px-4 md:px-6 py-5 border-b border-slate-100">
      <div className="rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-700 px-5 py-5 text-white">
        <p className="text-xs font-medium uppercase tracking-wide text-emerald-100 flex items-center gap-1.5">
          <Sparkles size={13} /> Collected hands-free this month
        </p>
        <p data-testid="hfcr-amount" className="mt-1.5 text-3xl font-semibold tabular-nums break-words">
          {formatCurrency(hfcrCents)}
        </p>
        <p className="mt-1 text-sm text-emerald-50">
          {recoveredCallCount > 0
            ? `${recoveredCallCount} ${recoveredCallCount === 1 ? 'call' : 'calls'} recovered · zero app taps`
            : 'Collected without opening the app.'}
        </p>
      </div>
    </section>
  );
}
