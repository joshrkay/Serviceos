/**
 * Technician phone — the on-call escalation number.
 *
 * A tradesperson sets their OWN mobile number so inbound-call escalation
 * (the dispatcher-phone-resolver) rings their cell instead of the shared
 * business line. GET /api/users/me/phone on open, PUT on save; the API
 * normalizes to E.164 and returns 400 on an invalid number. Leaving the field
 * blank clears the number (escalation falls back to the business line).
 */
import { useEffect, useState } from 'react';
import { X, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';

/** +15125551234 → (512) 555-1234 for display in the form. */
function formatPhoneForDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

interface TechnicianPhoneSheetProps {
  onClose: () => void;
  /** Called after a successful save with the new E.164 number (or null when cleared). */
  onSaved?: (mobileNumber: string | null) => void;
}

export function TechnicianPhoneSheet({ onClose, onSaved }: TechnicianPhoneSheetProps) {
  const [mobileNumber, setMobileNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/users/me/phone');
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const data = (await res.json()) as { mobileNumber: string | null };
        if (cancelled) return;
        setMobileNumber(data.mobileNumber ? formatPhoneForDisplay(data.mobileNumber) : '');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load your number');
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
    setSaving(true);
    try {
      const res = await apiFetch('/api/users/me/phone', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // null clears the number; a non-empty value is normalized to E.164 server-side.
        body: JSON.stringify({ mobileNumber: mobileNumber.trim() || null }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = typeof body?.message === 'string' ? body.message : '';
        } catch {
          /* non-JSON */
        }
        throw new Error(detail || `Save failed (${res.status})`);
      }
      const saved = (await res.json()) as { mobileNumber?: string | null };
      toast.success('Your number was saved');
      onSaved?.(saved.mobileNumber ?? null);
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
      aria-labelledby="tech-phone-title"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-2xl bg-white shadow-xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
          <span className="flex size-9 items-center justify-center rounded-xl bg-slate-100">
            <Smartphone size={16} className="text-slate-700" />
          </span>
          <h2 id="tech-phone-title" className="flex-1 text-base text-slate-900">
            Your phone number
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-11 size-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : (
            <label htmlFor="tech-phone" className="block">
              <span className="text-sm text-slate-700">Your cell phone</span>
              <span className="block text-xs text-slate-500 mt-0.5">
                When you&apos;re on call, inbound escalations ring this number
                instead of the shared business line. Leave blank to fall back to
                the business line.
              </span>
              <input
                id="tech-phone"
                type="tel"
                autoComplete="tel"
                inputMode="tel"
                aria-label="Your cell phone"
                value={mobileNumber}
                onChange={(e) => setMobileNumber(e.target.value)}
                placeholder="(512) 555-1234"
                className="mt-1.5 w-full min-h-11 rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:border-indigo-400 transition-colors"
              />
              {error && (
                <p className="mt-2 text-sm text-red-600" role="alert">
                  {error}
                </p>
              )}
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">
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
