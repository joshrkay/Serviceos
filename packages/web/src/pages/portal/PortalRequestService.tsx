/**
 * P10-001 — Service request form for the customer portal.
 *
 * Submits a `POST /api/public/portal/:token/request-service`. The
 * server creates a lead with `tenantId = req.portal.tenantId` and
 * `source = 'web_form'` / `sourceDetail = 'Customer Portal'`. The
 * UI validates a non-empty summary client-side before posting.
 */
import { FormEvent, useState } from 'react';
import { portalApi } from '../../api/portal';

interface FormState {
  summary: string;
  notes: string;
  primaryPhone: string;
  email: string;
}

export function PortalRequestService({ token }: { token: string }) {
  const [form, setForm] = useState<FormState>({
    summary: '',
    notes: '',
    primaryPhone: '',
    email: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!form.summary.trim()) {
      setError('Please describe what you need help with.');
      return;
    }
    setSubmitting(true);
    try {
      await portalApi.requestService(token, {
        summary: form.summary.trim(),
        notes: form.notes.trim() || undefined,
        primaryPhone: form.primaryPhone.trim() || undefined,
        email: form.email.trim() || undefined,
      });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
        <div className="text-lg font-semibold text-emerald-900">Request received</div>
        <div className="mt-2 text-sm text-emerald-800">
          Thanks — your service request has been sent. Someone will reach out soon.
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 space-y-4"
    >
      <div>
        <label htmlFor="portal-summary" className="block text-sm font-medium text-slate-700">
          What do you need help with?
        </label>
        <textarea
          id="portal-summary"
          rows={3}
          value={form.summary}
          onChange={(e) => update('summary', e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          placeholder="e.g. The water heater is leaking under the stairs."
        />
      </div>

      <div>
        <label htmlFor="portal-notes" className="block text-sm font-medium text-slate-700">
          Anything else? <span className="text-slate-400">(optional)</span>
        </label>
        <textarea
          id="portal-notes"
          rows={2}
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="portal-phone" className="block text-sm font-medium text-slate-700">
            Best phone <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="portal-phone"
            type="tel"
            value={form.primaryPhone}
            onChange={(e) => update('primaryPhone', e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="portal-email" className="block text-sm font-medium text-slate-700">
            Email <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="portal-email"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>
      </div>

      {error ? <div className="text-sm text-rose-600">{error}</div> : null}

      <button
        type="submit"
        disabled={submitting}
        className="w-full sm:w-auto rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm"
      >
        {submitting ? 'Sending…' : 'Send request'}
      </button>
    </form>
  );
}
