/**
 * #1288 — Default tax rate settings sheet.
 *
 * The tenant's default tax rate, stamped server-side onto every estimate and
 * invoice created without an explicit rate (the estimate/invoice forms leave
 * the field blank to take it; typing a rate — 0 included — overrides it).
 * Persists via PUT /api/settings `defaultTaxRateBps`. Percent in the UI,
 * integer basis points on the wire. Mirrors DiscountPolicySheet.
 */
import { useEffect, useState } from 'react';
import { X, Percent } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface TaxRateSheetProps {
  onClose: () => void;
}

export function TaxRateSheet({ onClose }: TaxRateSheetProps) {
  const [percent, setPercent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as { defaultTaxRateBps?: number | null };
        if (cancelled) return;
        setPercent(data.defaultTaxRateBps ? (data.defaultTaxRateBps / 100).toString() : '');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load tax rate');
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
    const trimmed = percent.trim();
    const pct = trimmed.length === 0 ? 0 : Number(trimmed);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('Tax rate must be between 0 and 100%.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultTaxRateBps: Math.round(pct * 100) }),
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
      toast.success('Default tax rate saved');
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
      aria-labelledby="tax-rate-title"
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
          <h2 id="tax-rate-title" className="flex-1 text-base text-slate-900">
            Tax rate
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
            Applied to taxable line items on new estimates and invoices when you leave their tax
            rate blank. A rate typed on a document always wins.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <div>
                <label htmlFor="default-tax-rate" className="text-sm text-slate-700">
                  Default tax rate
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    id="default-tax-rate"
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={percent}
                    onChange={(e) => setPercent(e.target.value)}
                    placeholder="0"
                    className="min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                  />
                  <span className="text-sm text-slate-500" aria-hidden="true">
                    %
                  </span>
                </div>
                <p className="block text-xs text-slate-400 mt-1">
                  0% (default) = no tax. A document that mixes taxable and non-taxable lines can't
                  carry a discount while taxed yet — the app will ask you to adjust it.
                </p>
              </div>

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
