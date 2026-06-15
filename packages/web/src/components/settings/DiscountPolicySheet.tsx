/**
 * P2-036 V2 (U7) — Discount-policy settings sheet.
 *
 * Lets a tenant opt into bounded AI discount handling on a negotiation:
 *   - Maximum discount the AI may auto-propose (basis points, surfaced as %).
 *   - Optional absolute price floor (dollars → cents) below which it never goes.
 *   - "Never below the catalog price" toggle (the catalog-grounded floor).
 *
 * FAIL-CLOSED: an empty/zero maximum means the AI proposes NO discounts —
 * identical to the pre-policy behavior, every haggling ask routes to the owner.
 * Persists end-to-end via PUT /api/settings (validated server-side; the
 * discount engine reads it via resolveDiscountPolicy).
 *
 * Mirrors DepositRulesSheet (same load/save/convert shape). Money is dollars in
 * the UI, integer cents/bps on the wire.
 */
import { useEffect, useState } from 'react';
import { X, Percent } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface DiscountPolicyFields {
  maxPercent: string; // 0–100, surfaced as percent; bps on save
  floorDollars: string; // optional absolute floor; dollars → cents
  neverBelowCatalog: boolean;
}

const EMPTY: DiscountPolicyFields = {
  maxPercent: '',
  floorDollars: '',
  neverBelowCatalog: true,
};

interface DiscountPolicySheetProps {
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

export function DiscountPolicySheet({ onClose }: DiscountPolicySheetProps) {
  const [fields, setFields] = useState<DiscountPolicyFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as {
          discountMaxBps?: number | null;
          discountFloorCents?: number | null;
          discountNeverBelowCatalog?: boolean | null;
        };
        if (cancelled) return;
        setFields({
          maxPercent: bpsToPercentString(data.discountMaxBps),
          floorDollars: centsToDollarsString(data.discountFloorCents),
          neverBelowCatalog: data.discountNeverBelowCatalog ?? true,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load discount policy');
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
    // Empty maximum = 0 = fail-closed (the AI auto-proposes no discounts).
    const pct =
      fields.maxPercent.trim().length === 0 ? 0 : parsePositiveNumber(fields.maxPercent);
    if (pct === null || pct > 100) {
      setError('Maximum discount must be between 0 and 100.');
      return;
    }
    let discountFloorCents: number | null = null;
    if (fields.floorDollars.trim().length > 0) {
      const dollars = parsePositiveNumber(fields.floorDollars);
      if (dollars === null) {
        setError('Floor amount must be a positive number.');
        return;
      }
      discountFloorCents = Math.round(dollars * 100);
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discountMaxBps: Math.round(pct * 100),
          discountFloorCents,
          discountNeverBelowCatalog: fields.neverBelowCatalog,
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
      toast.success('Discount policy saved');
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
      aria-labelledby="discount-policy-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Percent size={16} className="text-slate-700" />
          </span>
          <h2 id="discount-policy-title" className="flex-1 text-base text-slate-900">
            Discount policy
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Bound how the AI handles a customer haggling on price. Leave the maximum at{' '}
            <strong>0% to keep blocking all discounts</strong> (every ask routes to you). Set
            a higher cap to let the AI propose an in-policy discount as a one-tap approval — it
            never applies one automatically, and never goes below your floor.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <div>
                <label htmlFor="discount-max" className="text-sm text-slate-700">
                  Maximum discount the AI may propose
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    id="discount-max"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={fields.maxPercent}
                    onChange={(e) => setFields((f) => ({ ...f, maxPercent: e.target.value }))}
                    placeholder="0"
                    className="min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                  />
                  <span className="text-sm text-slate-500" aria-hidden="true">
                    %
                  </span>
                </div>
                <p className="block text-xs text-slate-400 mt-1">
                  0% = block all discounts (default). 10% lets the AI propose up to a 10% cut.
                </p>
              </div>

              <div>
                <label htmlFor="discount-floor" className="text-sm text-slate-700">
                  Never sell below (optional)
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-sm text-slate-500" aria-hidden="true">
                    $
                  </span>
                  <input
                    id="discount-floor"
                    type="number"
                    step="0.01"
                    min="0"
                    value={fields.floorDollars}
                    onChange={(e) => setFields((f) => ({ ...f, floorDollars: e.target.value }))}
                    placeholder="Leave blank for no absolute floor"
                    className="min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                  />
                </div>
                <p className="block text-xs text-slate-400 mt-1">
                  A hard price floor — the AI counters at this amount if a customer asks below it.
                </p>
              </div>

              <label className="flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-xl border border-slate-200 px-4 py-3 hover:border-slate-300 transition-colors">
                <input
                  type="checkbox"
                  checked={fields.neverBelowCatalog}
                  onChange={(e) =>
                    setFields((f) => ({ ...f, neverBelowCatalog: e.target.checked }))
                  }
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <p className="text-sm text-slate-800">Never below the catalog price</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Only auto-propose a discount when the quote is grounded in your catalog.
                  </p>
                </div>
              </label>

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
            className="min-h-11 rounded-xl px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="min-h-11 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
