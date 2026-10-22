/**
 * P10-001 — Service request form for the customer portal.
 *
 * Submits a `POST /api/public/portal/:token/request-service`. The
 * server creates a lead with `tenantId = req.portal.tenantId` and
 * `source = 'customer_portal'`. The
 * UI validates a non-empty summary client-side before posting.
 */
import { FormEvent, useState } from 'react';
import { portalApi } from '../../api/portal';
import { Input, Textarea } from '../../components/ui';
import { PORTAL_FIELD } from '../../components/customer/portalField';

interface FormState {
  summary: string;
  notes: string;
  primaryPhone: string;
  email: string;
  /** #1738 — starts unticked; a tick lets the instant reply text go out. */
  smsConsent: boolean;
}

export function PortalRequestService({ token }: { token: string }) {
  const [form, setForm] = useState<FormState>({
    summary: '',
    notes: '',
    primaryPhone: '',
    email: '',
    smsConsent: false,
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
        smsConsent: form.smsConsent,
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
      <div className="bg-success/10 border border-success/20 rounded-2xl p-6 text-center">
        <div className="text-lg font-semibold text-success">Request received</div>
        <div className="mt-2 text-sm text-success">
          Thanks — your service request has been sent. Someone will reach out soon.
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="bg-card rounded-2xl border border-border p-4 sm:p-6 space-y-4"
    >
      <div>
        <label htmlFor="portal-summary" className="block text-sm font-medium text-foreground">
          What do you need help with?
        </label>
        <Textarea
          id="portal-summary"
          rows={3}
          value={form.summary}
          onChange={(e) => update('summary', e.target.value)}
          className={`mt-1 ${PORTAL_FIELD}`}
          placeholder="e.g. The water heater is leaking under the stairs."
        />
      </div>

      <div>
        <label htmlFor="portal-notes" className="block text-sm font-medium text-foreground">
          Anything else? <span className="text-muted-foreground">(optional)</span>
        </label>
        <Textarea
          id="portal-notes"
          rows={2}
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
          className={`mt-1 ${PORTAL_FIELD}`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="portal-phone" className="block text-sm font-medium text-foreground">
            Best phone <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="portal-phone"
            type="tel"
            value={form.primaryPhone}
            onChange={(e) => update('primaryPhone', e.target.value)}
            className={`mt-1 ${PORTAL_FIELD}`}
          />
        </div>
        <div>
          <label htmlFor="portal-email" className="block text-sm font-medium text-foreground">
            Email <span className="text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="portal-email"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            className={`mt-1 ${PORTAL_FIELD}`}
          />
        </div>
      </div>

      <label
        data-testid="portal-sms-consent"
        className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5"
      >
        <input
          type="checkbox"
          checked={form.smsConsent}
          onChange={(e) => update('smsConsent', e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span className="min-w-0 text-sm text-foreground">
          Text me about this request.{' '}
          <span className="text-muted-foreground">Msg &amp; data rates may apply. Reply STOP to opt out.</span>
        </span>
      </label>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <button
        type="submit"
        disabled={submitting}
        className="w-full sm:w-auto rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm"
      >
        {submitting ? 'Sending…' : 'Send request'}
      </button>
    </form>
  );
}
