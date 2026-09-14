/**
 * #1143 (row 8.10) — late-fee policy settings: none / flat / percent, with a
 * grace period and an optional cap. Backed by GET/PUT /api/settings/dunning,
 * which writes ONLY the late-fee slice of the tenant's dunning config (the
 * reminder cadence is untouched). The overdue sweep reads the saved policy and
 * raises each fee as an owner-approved proposal — nothing is charged from here.
 *
 * Wire shape (packages/api/src/invoices/dunning-config.ts):
 *   - lateFeeValueCents: integer cents for 'flat'; basis points for 'percent'
 *     (UI surfaces dollars / percent).
 *   - lateFeeGraceDays: whole days past due before a fee is due.
 *   - lateFeeMaxCents: integer cents, or null for no cap.
 * Grace, the cap and rounding are applied server-side by the existing
 * late-fee calculation; this sheet only converts units.
 */
import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

type LateFeeType = 'none' | 'flat' | 'percent';

interface DunningPolicyResponse {
  lateFeeType?: LateFeeType;
  lateFeeValueCents?: number;
  lateFeeGraceDays?: number;
  lateFeeMaxCents?: number | null;
}

interface LateFeeFields {
  type: LateFeeType;
  flatDollars: string;
  percent: string;
  graceDays: string;
  maxDollars: string;
}

const EMPTY: LateFeeFields = {
  type: 'none',
  flatDollars: '',
  percent: '',
  graceDays: '',
  maxDollars: '',
};

interface DunningLateFeeSheetProps {
  onClose: () => void;
}

function centsToDollarsString(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2);
}

function parseNonNegativeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function DunningLateFeeSheet({ onClose }: DunningLateFeeSheetProps) {
  const [fields, setFields] = useState<LateFeeFields>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/settings/dunning');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as DunningPolicyResponse;
        if (cancelled) return;
        const type: LateFeeType = data.lateFeeType ?? 'none';
        setFields({
          type,
          flatDollars: type === 'flat' ? centsToDollarsString(data.lateFeeValueCents) : '',
          percent: type === 'percent' && data.lateFeeValueCents != null ? String(data.lateFeeValueCents / 100) : '',
          graceDays: type !== 'none' && data.lateFeeGraceDays != null ? String(data.lateFeeGraceDays) : '',
          maxDollars: type !== 'none' ? centsToDollarsString(data.lateFeeMaxCents) : '',
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the late fee policy');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** The PUT body, or a message explaining why the form can't be saved. */
  function buildPayload(): { body: Record<string, unknown> } | { message: string } {
    if (fields.type === 'none') return { body: { lateFeeType: 'none' } };

    let lateFeeValueCents: number;
    if (fields.type === 'flat') {
      const dollars = parseNonNegativeNumber(fields.flatDollars);
      const cents = dollars === null ? 0 : Math.round(dollars * 100);
      if (cents <= 0) return { message: 'Fee amount must be greater than $0.' };
      lateFeeValueCents = cents;
    } else {
      const pct = parseNonNegativeNumber(fields.percent);
      const bps = pct === null ? 0 : Math.round(pct * 100);
      if (bps <= 0 || bps > 10000) {
        return { message: 'Percentage must be greater than 0 and at most 100.' };
      }
      lateFeeValueCents = bps;
    }

    let lateFeeGraceDays = 0;
    if (fields.graceDays.trim().length > 0) {
      const days = parseNonNegativeNumber(fields.graceDays);
      if (days === null || !Number.isInteger(days)) {
        return { message: 'Grace period must be a whole number of days.' };
      }
      lateFeeGraceDays = days;
    }

    let lateFeeMaxCents: number | null = null;
    if (fields.maxDollars.trim().length > 0) {
      const dollars = parseNonNegativeNumber(fields.maxDollars);
      if (dollars === null) return { message: 'Maximum fee must be a positive amount.' };
      lateFeeMaxCents = Math.round(dollars * 100);
    }

    return { body: { lateFeeType: fields.type, lateFeeValueCents, lateFeeGraceDays, lateFeeMaxCents } };
  }

  async function save() {
    setError('');
    const payload = buildPayload();
    if ('message' in payload) {
      setError(payload.message);
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/dunning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload.body),
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
      toast.success('Late fee policy saved');
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
      onClick={onClose}
      role="dialog"
      aria-labelledby="late-fee-title"
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
          <h2 id="late-fee-title" className="flex-1 text-base text-slate-900">
            Late fees
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
            When an invoice is still unpaid after the grace period, Rivet drafts one late fee for
            it. <strong>You approve every fee before it is added to the invoice.</strong>
          </p>

          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <>
              <fieldset className="space-y-2" aria-labelledby="late-fee-type-label">
                <legend id="late-fee-type-label" className="text-sm text-slate-700">
                  Fee
                </legend>
                {(
                  [
                    { id: 'none', label: 'No late fee', desc: 'Overdue invoices get reminders only.' },
                    { id: 'flat', label: 'Flat fee', desc: 'The same dollar amount on each overdue invoice.' },
                    { id: 'percent', label: 'Percentage of balance', desc: 'A share of what is still owed, e.g. 1.5%.' },
                  ] as Array<{ id: LateFeeType; label: string; desc: string }>
                ).map((opt) => {
                  const active = fields.type === opt.id;
                  return (
                    <label
                      key={opt.id}
                      className={`flex w-full min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                        active ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="late-fee-type"
                        value={opt.id}
                        checked={active}
                        onChange={() => setFields((f) => ({ ...f, type: opt.id }))}
                        className="mt-0.5"
                      />
                      <div className="flex-1">
                        <p className={`text-sm ${active ? 'text-indigo-900' : 'text-slate-800'}`}>{opt.label}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{opt.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </fieldset>

              {fields.type === 'flat' && (
                <div>
                  <label htmlFor="late-fee-flat" className="text-sm text-slate-700">
                    Fee amount
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-sm text-slate-500" aria-hidden="true">$</span>
                    <input
                      id="late-fee-flat"
                      type="number"
                      step="0.01"
                      min="0"
                      value={fields.flatDollars}
                      onChange={(e) => setFields((f) => ({ ...f, flatDollars: e.target.value }))}
                      placeholder="25.00"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              {fields.type === 'percent' && (
                <div>
                  <label htmlFor="late-fee-percent" className="text-sm text-slate-700">
                    Percentage
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      id="late-fee-percent"
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={fields.percent}
                      onChange={(e) => setFields((f) => ({ ...f, percent: e.target.value }))}
                      placeholder="1.5"
                      className={inputClass}
                    />
                    <span className="text-sm text-slate-500" aria-hidden="true">%</span>
                  </div>
                </div>
              )}

              {fields.type !== 'none' && (
                <div>
                  <label htmlFor="late-fee-grace" className="text-sm text-slate-700">
                    Grace period (days)
                  </label>
                  <input
                    id="late-fee-grace"
                    type="number"
                    step="1"
                    min="0"
                    value={fields.graceDays}
                    onChange={(e) => setFields((f) => ({ ...f, graceDays: e.target.value }))}
                    placeholder="0"
                    className={`mt-1.5 ${inputClass}`}
                  />
                  <p className="block text-xs text-slate-400 mt-1">
                    Days past the due date before a fee is drafted.
                  </p>
                </div>
              )}

              {fields.type !== 'none' && (
                <div>
                  <label htmlFor="late-fee-max" className="text-sm text-slate-700">
                    Maximum fee (optional)
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-sm text-slate-500" aria-hidden="true">$</span>
                    <input
                      id="late-fee-max"
                      type="number"
                      step="0.01"
                      min="0"
                      value={fields.maxDollars}
                      onChange={(e) => setFields((f) => ({ ...f, maxDollars: e.target.value }))}
                      placeholder="Leave blank for no cap"
                      className={inputClass}
                    />
                  </div>
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
