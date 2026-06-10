import { useState } from 'react';
import { Check, ArrowRight } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button } from '../../../ui';

function friendlyBillingError(status: number, raw?: string): string {
  if (status === 503) return "Stripe isn't configured for this environment. Contact support to enable billing.";
  if (status === 400) return raw || 'Something looks off with the billing request. Try again or contact support.';
  if (status >= 500)  return 'Stripe is temporarily unavailable. Wait a minute and try again.';
  return raw || `Couldn't start checkout (HTTP ${status}).`;
}

export function BillingStep() {
  const apiFetch = useApiClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/onboarding/billing/checkout-session', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(friendlyBillingError(res.status, body.message));
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        window.location.href = body.url;
      } else {
        setError("Checkout didn't return a URL. Try again or contact support.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6 max-w-md">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Start your 14-day free trial</h1>
        <p className="text-sm text-slate-500 mt-2">
          Cancel anytime in Settings. We hold a card to keep your AI on after day 14 — nothing charges until then.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">What you get today</p>
        <ul className="mt-3 space-y-2 text-sm text-slate-700">
          {[
            'AI answers your phone the moment you turn it on',
            'AI drafts quotes from each call &amp; sends invoices when jobs close',
            '500 voice minutes / month included; $0.30 each after',
            'End-of-day digest by text — what got done, what got paid',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2">
              <Check size={16} className="mt-0.5 shrink-0 text-green-600" />
              <span dangerouslySetInnerHTML={{ __html: line }} />
            </li>
          ))}
        </ul>
      </div>

      <Button
        variant="primary"
        size="lg"
        loading={pending}
        onClick={() => void start()}
        rightIcon={<ArrowRight size={16} />}
      >
        {pending ? 'Opening Stripe checkout…' : 'Start 14-day free trial'}
      </Button>

      {error && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <p className="text-xs text-slate-500">
        You&apos;ll land on a secure Stripe page. We don&apos;t see or store your card number.
      </p>
    </div>
  );
}
