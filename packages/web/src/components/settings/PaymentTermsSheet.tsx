/**
 * #1402 §13 — Default payment terms sheet.
 *
 * How many days a customer has to pay a new invoice (0 = due on receipt).
 * Persists via PUT /api/settings `defaultPaymentTermDays` (whole days,
 * 0–365 — the API enforces the same bounds). Mirrors TaxRateSheet.
 */
import { useEffect, useState } from 'react';
import { X, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

interface PaymentTermsSheetProps {
  onClose: () => void;
}

export function PaymentTermsSheet({ onClose }: PaymentTermsSheetProps) {
  const [days, setDays] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as { defaultPaymentTermDays?: number | null };
        if (cancelled) return;
        setDays(String(data.defaultPaymentTermDays ?? 30));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load payment terms');
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
    const trimmed = days.trim();
    const value = Number(trimmed);
    if (trimmed === '' || !Number.isInteger(value) || value < 0 || value > 365) {
      setError('Enter a whole number of days from 0 to 365.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultPaymentTermDays: value }),
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
      toast.success('Payment terms saved');
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
      aria-labelledby="payment-terms-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 sticky top-0 bg-white">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <CalendarClock size={16} className="text-slate-700" />
          </span>
          <h2 id="payment-terms-title" className="flex-1 text-base text-slate-900">
            Payment terms
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
            Sets the due date on new invoices. Invoices already sent keep their due date.
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <div>
                <label htmlFor="payment-term-days" className="text-sm text-slate-700">
                  Payment due within
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    id="payment-term-days"
                    type="number"
                    inputMode="numeric"
                    step="1"
                    min="0"
                    max="365"
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    className="min-h-11 w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
                  />
                  <span className="text-sm text-slate-500" aria-hidden="true">
                    days
                  </span>
                </div>
                <p className="block text-xs text-slate-400 mt-1">
                  0 = due on receipt. Net 30 is the default.
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
