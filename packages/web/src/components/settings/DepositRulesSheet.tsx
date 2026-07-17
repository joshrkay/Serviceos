/**
 * Deposit rules settings — strategy (none / percentage / fixed) and
 * optional threshold. Persists through Settings UI and DB. Estimates
 * do not yet enforce the rule at draft time (separate follow-up).
 *
 * Field correlation mirrors the Zod schema + DB CHECK constraint:
 *   - 'none' (UI label for null strategy): all amount fields cleared.
 *   - 'percentage': depositPercentageBps required (0–10000 bps; UI
 *     surfaces it as 0–100%).
 *   - 'fixed': depositFixedCents required (>= 0; UI surfaces dollars).
 */
import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

type Strategy = 'none' | 'percentage' | 'fixed';
type TimingPolicy = 'before_approval' | 'after_approval';

interface DepositRulesFields {
  strategy: Strategy;
  percentagePercent: string;       // 0-100, surfaced as percent in UI
  fixedDollars: string;             // dollars, converted to cents on save
  requiredAboveDollars: string;     // optional threshold; empty = always
  timingPolicy: TimingPolicy;
}

const EMPTY: DepositRulesFields = {
  strategy: 'none',
  percentagePercent: '',
  fixedDollars: '',
  requiredAboveDollars: '',
  timingPolicy: 'after_approval',
};

interface DepositRulesSheetProps {
  onClose: () => void;
}

function bpsToPercentString(bps: number | null | undefined): string {
  if (bps == null) return '';
  return (bps / 100).toString();
}

function centsToDollarsString(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2);
}

function parsePositiveNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function DepositRulesSheet({ onClose }: DepositRulesSheetProps) {
  const [fields, setFields] = useState<DepositRulesFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as {
          depositStrategy?: 'percentage' | 'fixed' | null;
          depositPercentageBps?: number | null;
          depositFixedCents?: number | null;
          depositRequiredAboveCents?: number | null;
          depositTimingPolicy?: TimingPolicy;
        };
        if (cancelled) return;
        setFields({
          strategy: (data.depositStrategy ?? 'none') as Strategy,
          percentagePercent: bpsToPercentString(data.depositPercentageBps),
          fixedDollars: centsToDollarsString(data.depositFixedCents),
          requiredAboveDollars: centsToDollarsString(data.depositRequiredAboveCents),
          timingPolicy: data.depositTimingPolicy ?? 'after_approval',
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load deposit rules');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setError('');
    // Build the payload based on strategy. Each non-applicable field
    // gets explicit `null` so a switch from percentage→fixed clears
    // the previous percentage value rather than leaving stale data.
    let depositStrategy: 'percentage' | 'fixed' | null = null;
    let depositPercentageBps: number | null = null;
    let depositFixedCents: number | null = null;

    if (fields.strategy === 'percentage') {
      const pct = parsePositiveNumber(fields.percentagePercent);
      if (pct === null || pct > 100) {
        setError('Percentage must be between 0 and 100.');
        return;
      }
      depositStrategy = 'percentage';
      depositPercentageBps = Math.round(pct * 100);
    } else if (fields.strategy === 'fixed') {
      const dollars = parsePositiveNumber(fields.fixedDollars);
      if (dollars === null) {
        setError('Fixed deposit amount is required.');
        return;
      }
      depositStrategy = 'fixed';
      depositFixedCents = Math.round(dollars * 100);
    }

    // Codex P2 (PR #316): when strategy is 'none' the threshold is
    // meaningless — force it to null regardless of stale state in the
    // (hidden) input. Otherwise switching from percentage→none with a
    // previously-set threshold leaves a hidden value persisted that
    // silently re-applies if the strategy is turned back on later.
    let depositRequiredAboveCents: number | null = null;
    if (fields.strategy !== 'none' && fields.requiredAboveDollars.trim().length > 0) {
      const dollars = parsePositiveNumber(fields.requiredAboveDollars);
      if (dollars === null) {
        setError('Threshold amount must be a positive number.');
        return;
      }
      depositRequiredAboveCents = Math.round(dollars * 100);
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          depositStrategy,
          depositPercentageBps,
          depositFixedCents,
          depositRequiredAboveCents,
          depositTimingPolicy: fields.timingPolicy,
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON body */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      toast.success('Deposit rules saved');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="deposit-rules-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <FileText size={16} className="text-slate-700" />
          </span>
          <h2 id="deposit-rules-title" className="flex-1 text-base text-slate-900">
            Deposit rules
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Require a deposit before work begins on an estimate. Deposits encourage
            customers to confirm the job and reduce no-show risk.{' '}
            <strong>This setting persists today; estimates start enforcing it
            in a follow-up release.</strong>
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <fieldset className="space-y-2" aria-labelledby="strategy-label">
                <legend id="strategy-label" className="text-sm text-slate-700">
                  Strategy
                </legend>
                {(
                  [
                    { id: 'none', label: 'No deposit', desc: 'Don\'t require a deposit on any estimate.' },
                    { id: 'percentage', label: 'Percentage of total', desc: 'e.g. 25% of the estimate total.' },
                    { id: 'fixed', label: 'Fixed amount', desc: 'A flat dollar amount regardless of total.' },
                  ] as Array<{ id: Strategy; label: string; desc: string }>
                ).map((opt) => {
                  const active = fields.strategy === opt.id;
                  return (
                    <label
                      key={opt.id}
                      className={`flex w-full cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                        active ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="deposit-strategy"
                        value={opt.id}
                        checked={active}
                        onChange={() => setFields((f) => ({ ...f, strategy: opt.id }))}
                        className="mt-0.5"
                      />
                      <div className="flex-1">
                        <p className={`text-sm ${active ? 'text-indigo-900' : 'text-slate-800'}`}>
                          {opt.label}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">{opt.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </fieldset>

              {fields.strategy === 'percentage' && (
                <div>
                  <label htmlFor="deposit-percent" className="text-sm text-slate-700">
                    Percentage
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      id="deposit-percent"
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={fields.percentagePercent}
                      onChange={(e) =>
                        setFields((f) => ({ ...f, percentagePercent: e.target.value }))
                      }
                      placeholder="25"
                      className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                    />
                    <span className="text-sm text-slate-500" aria-hidden="true">%</span>
                  </div>
                </div>
              )}

              {fields.strategy === 'fixed' && (
                <div>
                  <label htmlFor="deposit-fixed" className="text-sm text-slate-700">
                    Deposit amount
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-sm text-slate-500" aria-hidden="true">$</span>
                    <input
                      id="deposit-fixed"
                      type="number"
                      step="0.01"
                      min="0"
                      value={fields.fixedDollars}
                      onChange={(e) =>
                        setFields((f) => ({ ...f, fixedDollars: e.target.value }))
                      }
                      placeholder="500.00"
                      className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                    />
                  </div>
                </div>
              )}

              {fields.strategy !== 'none' && (
                <fieldset className="space-y-2" aria-labelledby="timing-label">
                  <legend id="timing-label" className="text-sm text-slate-700">
                    When to collect
                  </legend>
                  {(
                    [
                      {
                        id: 'after_approval',
                        label: 'After the customer approves',
                        desc: 'Customer accepts the estimate, then sees the payment link.',
                      },
                      {
                        id: 'before_approval',
                        label: 'Before the customer can approve',
                        desc: 'Deposit must be paid first; the Approve button stays disabled until then.',
                      },
                    ] as Array<{ id: TimingPolicy; label: string; desc: string }>
                  ).map((opt) => {
                    const active = fields.timingPolicy === opt.id;
                    return (
                      <label
                        key={opt.id}
                        className={`flex w-full cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                          active ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <input
                          type="radio"
                          name="deposit-timing-policy"
                          value={opt.id}
                          checked={active}
                          onChange={() => setFields((f) => ({ ...f, timingPolicy: opt.id }))}
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <p className={`text-sm ${active ? 'text-indigo-900' : 'text-slate-800'}`}>
                            {opt.label}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5">{opt.desc}</p>
                        </div>
                      </label>
                    );
                  })}
                </fieldset>
              )}

              {fields.strategy !== 'none' && (
                <div>
                  <label htmlFor="deposit-threshold" className="text-sm text-slate-700">
                    Only require above (optional)
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-sm text-slate-500" aria-hidden="true">$</span>
                    <input
                      id="deposit-threshold"
                      type="number"
                      step="0.01"
                      min="0"
                      value={fields.requiredAboveDollars}
                      onChange={(e) =>
                        setFields((f) => ({ ...f, requiredAboveDollars: e.target.value }))
                      }
                      placeholder="Leave blank to apply to every estimate"
                      className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                    />
                  </div>
                  <p className="block text-xs text-slate-400 mt-1">
                    Smaller jobs (under this threshold) won't require a deposit.
                  </p>
                </div>
              )}

              {error && (
                <p className="text-sm text-red-600" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sticky bottom-0 bg-white">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
