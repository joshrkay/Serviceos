import { useState } from 'react';
import { useApiClient } from '../../../../lib/apiClient';

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
        if (res.status === 503) {
          setError(
            "Stripe isn't configured for this environment. Contact support to enable billing.",
          );
        } else {
          setError(`HTTP ${res.status}`);
        }
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        window.location.href = body.url;
      } else {
        setError('Checkout session returned no URL.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5 max-w-md">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Start your 14-day free trial</h1>
        <p className="text-sm text-slate-500 mt-1">
          Card required. You won't be charged for 14 days, and you can cancel anytime.
        </p>
      </header>

      <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
        <li>Your AI agent goes live immediately after subscribing</li>
        <li>Day-15 auto-renewal — cancel anytime from Settings</li>
        <li>Trial caps lift once your subscription is active</li>
      </ul>

      <button
        type="button"
        onClick={() => void start()}
        disabled={pending}
        className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
      >
        {pending ? 'Opening checkout…' : 'Start 14-day free trial'}
      </button>

      {error && <p className="text-red-600 text-sm">{error}</p>}
    </div>
  );
}
