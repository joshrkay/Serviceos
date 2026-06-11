import React, { useCallback, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

const SOURCES = [
  'web_form',
  'phone_call',
  'referral',
  'walk_in',
  'marketplace',
  'other',
] as const;

export interface LeadCreateProps {
  onCreated?: (leadId: string) => void;
  onCancel?: () => void;
}

interface FormState {
  firstName: string;
  lastName: string;
  companyName: string;
  primaryPhone: string;
  email: string;
  source: typeof SOURCES[number];
  sourceDetail: string;
  estimatedValueDollars: string;
  notes: string;
}

const empty: FormState = {
  firstName: '',
  lastName: '',
  companyName: '',
  primaryPhone: '',
  email: '',
  source: 'web_form',
  sourceDetail: '',
  estimatedValueDollars: '',
  notes: '',
};

function parseDollarCents(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new Error('Estimated value must be a non-negative dollar amount with up to two decimal places.');
  }
  const dollars = Number.parseInt(match[1], 10);
  const cents = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10);
  return dollars * 100 + cents;
}

export function LeadCreate({ onCreated, onCancel }: LeadCreateProps) {
  const apiFetch = useApiClient();
  const [form, setForm] = useState<FormState>(empty);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!form.firstName.trim() && !form.companyName.trim()) {
        setError('First name or company is required.');
        return;
      }

      let cents: number | undefined;
      try {
        cents = parseDollarCents(form.estimatedValueDollars);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Estimated value is invalid.');
        return;
      }

      const body = {
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        primaryPhone: form.primaryPhone.trim() || undefined,
        email: form.email.trim() || undefined,
        source: form.source,
        sourceDetail: form.sourceDetail.trim() || undefined,
        estimatedValueCents: cents,
        notes: form.notes.trim() || undefined,
      };

      setSubmitting(true);
      try {
        const res = await apiFetch('/api/leads', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        const created = await res.json();
        onCreated?.(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create lead');
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-2xl mx-auto">
      <h1 className="text-lg text-slate-900 mb-4">New Lead</h1>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-500">
          First name
          <input
            value={form.firstName}
            onChange={(e) => setField('firstName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Last name
          <input
            value={form.lastName}
            onChange={(e) => setField('lastName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Company
          <input
            value={form.companyName}
            onChange={(e) => setField('companyName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Phone
          <input
            value={form.primaryPhone}
            onChange={(e) => setField('primaryPhone', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Source
          <select
            value={form.source}
            onChange={(e) => setField('source', e.target.value as FormState['source'])}
            className={inputCls}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Source detail
          <input
            value={form.sourceDetail}
            onChange={(e) => setField('sourceDetail', e.target.value)}
            placeholder="campaign or referrer"
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Estimated value (USD)
          <input
            value={form.estimatedValueDollars}
            onChange={(e) => setField('estimatedValueDollars', e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Notes
          <textarea
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={4}
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 text-white text-sm px-4 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Create lead'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-200 text-slate-700 text-sm px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
