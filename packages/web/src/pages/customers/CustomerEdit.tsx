import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Field, Input, Select, Textarea, Button } from '../../components/ui';

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
  // D4: SMS consent capture
  smsConsent: boolean;
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
  smsConsent: false,
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
          smsConsent: data.smsConsent ?? false,
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

      // Cleared optionals serialize as '' — never a dropped key. The server
      // only SETs columns for keys present in the body, so `|| undefined`
      // (which JSON.stringify drops) silently kept the previous value while
      // the form claimed the save succeeded.
      const body = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        companyName: form.companyName.trim(),
        primaryPhone: form.primaryPhone.trim(),
        secondaryPhone: form.secondaryPhone.trim(),
        email: form.email.trim(),
        preferredChannel: form.preferredChannel,
        communicationNotes: form.communicationNotes.trim(),
        // D4: Include SMS consent in update
        smsConsent: form.smsConsent,
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

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="customer-edit-loading">
        Loading…
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 md:p-6 max-w-2xl mx-auto" data-testid="customer-edit-form">
      <h1 className="text-lg text-foreground mb-4">Edit Customer</h1>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="First name">
          <Input
            aria-label="firstName"
            value={form.firstName}
            onChange={(e) => setField('firstName', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Last name">
          <Input
            aria-label="lastName"
            value={form.lastName}
            onChange={(e) => setField('lastName', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Company" className="md:col-span-2">
          <Input
            aria-label="companyName"
            value={form.companyName}
            onChange={(e) => setField('companyName', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Primary phone">
          <Input
            aria-label="primaryPhone"
            value={form.primaryPhone}
            onChange={(e) => setField('primaryPhone', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Secondary phone">
          <Input
            aria-label="secondaryPhone"
            value={form.secondaryPhone}
            onChange={(e) => setField('secondaryPhone', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Email">
          <Input
            aria-label="email"
            type="email"
            value={form.email}
            onChange={(e) => setField('email', e.target.value)}
            className="min-h-11"
          />
        </Field>
        <Field label="Preferred channel">
          <Select
            aria-label="preferredChannel"
            value={form.preferredChannel}
            onChange={(e) => setField('preferredChannel', e.target.value as FormState['preferredChannel'])}
            className="min-h-11"
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        </Field>
        {/* D4: SMS consent checkbox */}
        <div className="md:col-span-2 flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
          <input
            type="checkbox"
            id="smsConsent"
            checked={form.smsConsent}
            onChange={(e) => setField('smsConsent', e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
          />
          <label htmlFor="smsConsent" className="flex-1 cursor-pointer">
            <span className="text-sm text-foreground">SMS messaging consent</span>
            <p className="text-xs text-muted-foreground mt-0.5">
              Customer has consented to receive SMS messages including appointment reminders, estimates, and invoices.
            </p>
          </label>
        </div>
        <Field label="Customer notes" className="md:col-span-2">
          <Textarea
            aria-label="communicationNotes"
            value={form.communicationNotes}
            onChange={(e) => setField('communicationNotes', e.target.value)}
            rows={4}
            className="min-h-11"
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-2">
        <Button type="submit" disabled={submitting} className="min-h-11">
          {submitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11">
          Cancel
        </Button>
      </div>
    </form>
  );
}
