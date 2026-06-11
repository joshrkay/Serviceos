import React, { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../../lib/apiClient';

const CHANNELS = ['email', 'sms', 'phone', 'mail'] as const;

export interface CustomerEditProps {
  customerId: string;
  onSaved?: (customerId: string) => void;
  onCancel?: () => void;
}

interface FormState {
  firstName: string;
  lastName: string;
  companyName: string;
  primaryPhone: string;
  secondaryPhone: string;
  email: string;
  preferredChannel: typeof CHANNELS[number];
  communicationNotes: string;
}

const empty: FormState = {
  firstName: '',
  lastName: '',
  companyName: '',
  primaryPhone: '',
  secondaryPhone: '',
  email: '',
  preferredChannel: 'email',
  communicationNotes: '',
};

/**
 * P11-007 — CustomerEdit.
 *
 * Loads an existing customer and PUTs the updated fields back to the API.
 * The API exposes PUT /api/customers/:id (no PATCH) so we send a full
 * field set; unset optional fields become empty strings — the back-end
 * coerces blanks to null.
 */
export function CustomerEdit({ customerId, onSaved, onCancel }: CustomerEditProps) {
  const apiFetch = useApiClient();
  const [form, setForm] = useState<FormState>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/customers/${customerId}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        setForm({
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          companyName: data.companyName ?? '',
          primaryPhone: data.primaryPhone ?? '',
          secondaryPhone: data.secondaryPhone ?? '',
          email: data.email ?? '',
          preferredChannel: (CHANNELS.includes(data.preferredChannel)
            ? data.preferredChannel
            : 'email') as FormState['preferredChannel'],
          communicationNotes: data.communicationNotes ?? '',
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load customer');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (!form.firstName.trim() && !form.companyName.trim()) {
        setError('First name or company is required.');
        return;
      }

      const body = {
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
        companyName: form.companyName.trim() || undefined,
        primaryPhone: form.primaryPhone.trim() || undefined,
        secondaryPhone: form.secondaryPhone.trim() || undefined,
        email: form.email.trim() || undefined,
        preferredChannel: form.preferredChannel,
        communicationNotes: form.communicationNotes.trim() || '',
      };

      setSubmitting(true);
      try {
        const res = await apiFetch(`/api/customers/${customerId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json?.message ?? `HTTP ${res.status}`);
        }
        onSaved?.(customerId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save customer');
      } finally {
        setSubmitting(false);
      }
    },
    [form, customerId, onSaved]
  );

  const inputCls = 'w-full rounded-lg border border-slate-200 px-3 py-2 text-sm';

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="customer-edit-loading">
        Loading…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="customer-edit-form">
      <h1 className="text-lg text-slate-900 mb-4">Edit Customer</h1>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-slate-500">
          First name
          <input
            aria-label="firstName"
            value={form.firstName}
            onChange={(e) => setField('firstName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Last name
          <input
            aria-label="lastName"
            value={form.lastName}
            onChange={(e) => setField('lastName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Company
          <input
            aria-label="companyName"
            value={form.companyName}
            onChange={(e) => setField('companyName', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Primary phone
          <input
            aria-label="primaryPhone"
            value={form.primaryPhone}
            onChange={(e) => setField('primaryPhone', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Secondary phone
          <input
            aria-label="secondaryPhone"
            value={form.secondaryPhone}
            onChange={(e) => setField('secondaryPhone', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Email
          <input
            aria-label="email"
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="text-xs text-slate-500">
          Preferred channel
          <select
            aria-label="preferredChannel"
            value={form.preferredChannel}
            onChange={(e) => setField('preferredChannel', e.target.value as FormState['preferredChannel'])}
            className={inputCls}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500 md:col-span-2">
          Customer notes
          <textarea
            aria-label="communicationNotes"
            value={form.communicationNotes}
            onChange={(e) => setField('communicationNotes', e.target.value)}
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
          {submitting ? 'Saving…' : 'Save'}
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
