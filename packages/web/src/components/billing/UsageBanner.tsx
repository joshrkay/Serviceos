import { useEffect, useState } from 'react';
import { formatCurrency } from '../../utils/currency';
import { Link } from 'react-router';
import { Phone } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';

/** The paid-period shape of GET /api/billing/ai-usage (other kinds hide the banner). */
interface PeriodUsage {
  kind: 'period';
  usedMinutes: number;
  includedMinutes: number;
  overageMinutes: number;
  overageCentsPerMinute: number;
  projectedChargeCents: number;
  capCents: number | null;
  /** Server's isOverageCapReached — the one rule; never recomputed here. */
  capReached: boolean;
}

/**
 * In-app half of the AI-minute usage alerts (the owner is also emailed):
 * a note at 80% of the included minutes, the overage rate once they are
 * used, and — most prominently — that calls now ring the owner once the
 * overage cap is reached. Hidden during the trial and below 80%.
 */
export function UsageBanner() {
  const apiFetch = useApiClient();
  const [usage, setUsage] = useState<PeriodUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(apiFetch('/api/billing/ai-usage'))
      .then(async (res) => {
        if (cancelled || !res?.ok) return;
        const body = (await res.json()) as { kind: string };
        if (body.kind === 'period') setUsage(body as PeriodUsage);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (!usage || usage.usedMinutes * 100 < usage.includedMinutes * 80) return null;

  const { capReached } = usage;
  const message = capReached
    ? `Your ${formatCurrency(usage.capCents ?? 0)} overage cap is reached — calls ring you instead of the AI.`
    : usage.usedMinutes >= usage.includedMinutes
      ? `All ${usage.includedMinutes} included AI minutes used — extra minutes are ${formatCurrency(
          usage.overageCentsPerMinute,
        )} each (${formatCurrency(usage.projectedChargeCents)} so far).`
      : `You've used ${usage.usedMinutes} of your ${usage.includedMinutes} AI answering minutes.`;

  return (
    <div
      className={`border-b px-4 py-2 text-sm flex flex-wrap items-center gap-3 ${
        capReached ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-900'
      }`}
    >
      <Phone size={16} className="shrink-0" />
      <span className="flex-1 min-w-0">{message}</span>
      <Link
        to="/settings"
        className="min-h-11 inline-flex items-center rounded-lg px-3 font-medium underline underline-offset-2"
      >
        {capReached ? 'Raise the cap' : 'View usage'}
      </Link>
    </div>
  );
}
