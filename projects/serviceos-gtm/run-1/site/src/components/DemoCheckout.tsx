'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getPlan } from '@/lib/plans';

/**
 * SIMULATED checkout used only when Stripe test keys are NOT configured. It
 * mimics the Stripe-hosted checkout UI and, on success, calls the same internal
 * onTrialStarted() hook the real webhook fires — so the lifecycle/nurture path is
 * exercised end to end even in demo mode.
 */
export function DemoCheckout() {
  const params = useSearchParams();
  const plan = getPlan(params.get('plan'));
  const email = params.get('email') ?? '';
  const businessName = params.get('business_name') ?? '';
  const vertical = params.get('vertical') ?? '';

  const [declined, setDeclined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/demo/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan.id, email, businessName, vertical }),
      });
      if (!res.ok) throw new Error('Demo completion failed.');
      window.location.assign('/signup/success?session_id=demo_session');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error.');
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div
        role="status"
        className="rounded-t-lg border border-warning/50 bg-warning/15 px-4 py-3 text-sm text-fg"
      >
        <strong>SIMULATED CHECKOUT</strong> — Stripe test keys aren&apos;t configured in this preview build.
        With keys set, this step hands off to Stripe-hosted checkout instead.
      </div>

      <div className="rounded-b-lg border border-t-0 border-border bg-surface p-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-display text-xl font-bold text-fg">{plan.name} plan</h1>
          <span className="text-fg-muted">{plan.priceLabel}/mo</span>
        </div>
        <p className="mt-1 text-xs text-fg-muted">14-day free trial, then {plan.priceLabel}/mo. Cancel anytime.</p>
        {email && <p className="mt-3 text-sm text-fg-muted">Billing email: {email}</p>}

        {declined && (
          <p role="alert" className="mt-4 rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-fg">
            Your card was declined (simulated). Please try a different card.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-fg">
            {error}
          </p>
        )}

        {/* Fake card form, pre-filled with the Stripe test card. */}
        <div className="mt-6 space-y-4">
          <div>
            <label htmlFor="demo-card" className="field-label">
              Card number
            </label>
            <input id="demo-card" className="field-input" defaultValue="4242 4242 4242 4242" readOnly />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="demo-exp" className="field-label">
                Expiry
              </label>
              <input id="demo-exp" className="field-input" defaultValue="12 / 34" readOnly />
            </div>
            <div>
              <label htmlFor="demo-cvc" className="field-label">
                CVC
              </label>
              <input id="demo-cvc" className="field-input" defaultValue="123" readOnly />
            </div>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <button
            type="button"
            onClick={complete}
            disabled={submitting}
            className="btn-primary w-full"
          >
            {submitting ? 'Processing…' : 'Complete trial signup'}
          </button>
          <button
            type="button"
            onClick={() => setDeclined(true)}
            disabled={submitting}
            className="btn-secondary w-full"
          >
            Simulate card declined
          </button>
          {declined && (
            <button
              type="button"
              onClick={() => setDeclined(false)}
              className="btn-secondary w-full"
            >
              Retry with valid card
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
