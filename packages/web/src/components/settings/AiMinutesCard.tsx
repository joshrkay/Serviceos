import { useEffect, useState } from 'react';
import { formatCurrency } from '../../utils/currency';
import { Phone } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/** Mirrors GET /api/billing/ai-usage. */
type AiUsage =
  | { kind: 'trial'; usedMinutes: number; includedMinutes: number }
  | {
      kind: 'period';
      usedMinutes: number;
      includedMinutes: number;
      overageMinutes: number;
      overageCentsPerMinute: number;
      projectedChargeCents: number;
      capCents: number | null;
    }
  | { kind: 'none' };

/**
 * AI answering minutes on Settings: usage against the plan bundle (or the
 * trial allowance) and, for the owner, the monthly overage cap — once it is
 * reached, calls ring the owner instead of the AI answering.
 */
export function AiMinutesCard({ canManage }: { canManage: boolean }) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [capDollars, setCapDollars] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Some embedders/tests pass a partial API adapter that returns
    // undefined for unknown endpoints; treat that as "no usage to show".
    void Promise.resolve(apiFetch('/api/billing/ai-usage'))
      .then(async (res) => {
        if (cancelled || !res?.ok) return;
        const body = (await res.json()) as AiUsage;
        setUsage(body);
        if (body.kind === 'period' && body.capCents !== null) {
          setCapDollars(String(body.capCents / 100));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveCap(capCents: number | null) {
    setSaving(true);
    try {
      const res = await apiFetch('/api/billing/ai-overage-cap', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capCents }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setUsage((u) => (u && u.kind === 'period' ? { ...u, capCents } : u));
      if (capCents === null) setCapDollars('');
      toast.success(capCents === null ? 'Overage cap removed' : `Overage cap set to ${formatCurrency(capCents)}`);
    } catch {
      toast.error('Could not update the overage cap');
    } finally {
      setSaving(false);
    }
  }

  if (!usage || usage.kind === 'none') return null;

  const parsedCap = Number(capDollars);
  const capValid = capDollars.trim() !== '' && Number.isFinite(parsedCap) && parsedCap >= 0;

  return (
    <div className="rounded-xl bg-white border border-slate-200 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100">
          <Phone size={14} className="text-slate-500" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-800">
            {usage.kind === 'trial'
              ? `${usage.usedMinutes} of ${usage.includedMinutes} trial AI minutes used`
              : `${usage.usedMinutes} of ${usage.includedMinutes} AI minutes used`}
          </p>
          {usage.kind === 'period' && (
            <p className="text-xs text-slate-400 mt-0.5">
              {usage.overageMinutes > 0
                ? `${usage.overageMinutes} extra minutes at ${formatCurrency(usage.overageCentsPerMinute)}/min · ${formatCurrency(usage.projectedChargeCents)} so far this period`
                : `Extra minutes are ${formatCurrency(usage.overageCentsPerMinute)}/min`}
            </p>
          )}
        </div>
      </div>

      {usage.kind === 'period' && canManage && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <label htmlFor="ai-overage-cap" className="block text-xs text-slate-500 mb-1">
            Monthly overage cap ($) — after it, calls ring you instead
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="ai-overage-cap"
              type="number"
              min={0}
              step={1}
              inputMode="decimal"
              placeholder={usage.capCents === null ? 'No cap' : undefined}
              value={capDollars === '' ? '' : Number(capDollars)}
              onChange={(e) => setCapDollars(e.target.value)}
              className="w-28 min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-indigo-400"
            />
            <button
              type="button"
              disabled={saving || !capValid}
              onClick={() => void saveCap(Math.round(parsedCap * 100))}
              className="min-h-11 rounded-xl bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              Save cap
            </button>
            <button
              type="button"
              disabled={saving || usage.capCents === null}
              onClick={() => void saveCap(null)}
              className="min-h-11 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
            >
              Remove cap
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
