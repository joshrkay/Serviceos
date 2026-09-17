import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../utils/api-fetch';
import { Field, Input, Select, Textarea, Button } from '../../components/ui';
import { formatApiErrorMessage } from '../../utils/api-errors';

const CHANNELS = ['email', 'sms', 'phone', 'mail'] as const;

// #1155 — `customers.account_type`. A business / property-manager account's
// inbound calls route as PRIORITY with its managed properties in context.
// '' = not classified (the key is omitted from the request).
const ACCOUNT_TYPES = [
  { value: '', label: 'Not set' },
  { value: 'residential', label: 'Residential' },
  { value: 'b2b', label: 'Business' },
  { value: 'property_manager', label: 'Property manager' },
] as const;
type AccountTypeOption = (typeof ACCOUNT_TYPES)[number]['value'];

export interface CustomerEditProps {
  // Omitted for the create flow (`/customers/new`) — the form starts blank
  // and POSTs a new customer instead of loading + PUTing an existing one.
  customerId?: string;
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
  accountType: AccountTypeOption;
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
  accountType: '',
};

/**
 * P11-007 — CustomerEdit.
 *
 * With a `customerId`, loads the existing customer and PUTs the updated
 * fields back to the API (PUT /api/customers/:id — no PATCH — so we send a
 * full field set; unset optional fields become empty strings, which the
 * back-end coerces to null).
 *
 * Without one (the `/customers/new` create route), the form starts blank
 * and submits via POST /api/customers instead — same fields, same client
 * validation, no fetch-on-mount.
 */
export function CustomerEdit({ customerId, onSaved, onCancel }: CustomerEditProps) {
  const [form, setForm] = useState<FormState>(empty);
  const [loading, setLoading] = useState(Boolean(customerId));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // #1155 — true once the loaded customer already carries a classification.
  // PUT cannot clear accountType (no un-classify path), so "Not set" would be
  // a silent no-op save; it is only offered while nothing is stored.
  const [hasStoredAccountType, setHasStoredAccountType] = useState(false);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    if (!customerId) return; // create mode: nothing to load, form starts blank
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
          accountType: (ACCOUNT_TYPES.some((t) => t.value === data.accountType)
            ? data.accountType
            : '') as AccountTypeOption,
        });
        setHasStoredAccountType(
          ACCOUNT_TYPES.some((t) => t.value !== '' && t.value === data.accountType),
        );
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

      if (customerId) {
        if (!form.firstName.trim() && !form.companyName.trim()) {
          setError('First name or company is required.');
          return;
        }
      } else {
        // Create mode matches the server's createCustomerSchema
        // (packages/api/src/shared/contracts.ts), which requires BOTH
        // firstName and lastName — unlike PUT/update, POST /api/customers
        // has no "or company" fallback. AddCustomerSheet (the other create
        // path, CustomersPage.tsx) agrees: it has no company field and
        // always derives both names before POSTing. Catching this
        // client-side, with a message naming the missing field, keeps a
        // company-only submit from round-tripping to a 400 the user never
        // asked for.
        if (!form.firstName.trim()) {
          setError('First name is required.');
          return;
        }
        if (!form.lastName.trim()) {
          setError('Last name is required.');
          return;
        }
      }

      // Cleared optionals serialize as '' — never a dropped key. The server
      // only SETs columns for keys present in the body, so `|| undefined`
      // (which JSON.stringify drops) silently kept the previous value while
      // the form claimed the save succeeded.
      const body = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        ...(customerId || form.companyName.trim() ? { companyName: form.companyName.trim() } : {}),
        ...(customerId || form.primaryPhone.trim() ? { primaryPhone: form.primaryPhone.trim() } : {}),
        ...(customerId || form.secondaryPhone.trim() ? { secondaryPhone: form.secondaryPhone.trim() } : {}),
        ...(customerId || form.email.trim() ? { email: form.email.trim() } : {}),
        preferredChannel: form.preferredChannel,
        ...(customerId || form.communicationNotes.trim()
          ? { communicationNotes: form.communicationNotes.trim() }
          : {}),
        // D4: Include SMS consent in update
        smsConsent: form.smsConsent,
        // #1155 — only a chosen classification is sent.
        ...(form.accountType ? { accountType: form.accountType } : {}),
      };

      setSubmitting(true);
      try {
        const res = customerId
          ? await apiFetch(`/api/customers/${customerId}`, {
              method: 'PUT',
              body: JSON.stringify(body),
            })
          : await apiFetch('/api/customers', {
              method: 'POST',
              body: JSON.stringify(body),
            });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(formatApiErrorMessage(json, `HTTP ${res.status}`));
        }
        const saved = await res.json();
        onSaved?.(customerId ?? saved.id);
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
      <h1 className="text-lg text-foreground mb-4">{customerId ? 'Edit Customer' : 'New Customer'}</h1>

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
        <Field label="Account type">
          <Select
            aria-label="accountType"
            value={form.accountType}
            onChange={(e) => setField('accountType', e.target.value as AccountTypeOption)}
            className="min-h-11"
          >
            {ACCOUNT_TYPES.filter((t) => t.value !== '' || !hasStoredAccountType).map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
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
          {customerId
            ? (submitting ? 'Saving…' : 'Save')
            : (submitting ? 'Creating…' : 'Create')}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className="min-h-11">
          Cancel
        </Button>
      </div>
    </form>
  );
}
