import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '../../utils/api-fetch';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';

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
        toast.success('Lead created');
        onCreated?.(created.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create lead';
        setError(message);
        toast.error(message);
      } finally {
        setSubmitting(false);
      }
    },
    [form, onCreated]
  );

  return (
    <form onSubmit={handleSubmit} className="mx-auto max-w-2xl p-4 md:p-6">
      <h1 className="mb-4 text-slate-900">New Lead</h1>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label="First name">
          <Input
            value={form.firstName}
            onChange={(e) => setField('firstName', e.target.value)}
          />
        </Field>
        <Field label="Last name">
          <Input
            value={form.lastName}
            onChange={(e) => setField('lastName', e.target.value)}
          />
        </Field>
        <Field label="Company" className="md:col-span-2">
          <Input
            value={form.companyName}
            onChange={(e) => setField('companyName', e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <Input
            value={form.primaryPhone}
            onChange={(e) => setField('primaryPhone', e.target.value)}
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
          />
        </Field>
        <Field label="Source">
          <Select
            value={form.source}
            onChange={(e) => setField('source', e.target.value as FormState['source'])}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label="Source detail">
          <Input
            value={form.sourceDetail}
            onChange={(e) => setField('sourceDetail', e.target.value)}
            placeholder="campaign or referrer"
          />
        </Field>
        <Field label="Estimated value (USD)" className="md:col-span-2">
          <Input
            value={form.estimatedValueDollars}
            onChange={(e) => setField('estimatedValueDollars', e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </Field>
        <Field label="Notes" className="md:col-span-2">
          <Textarea
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={4}
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="submit" loading={submitting}>
          Create lead
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
