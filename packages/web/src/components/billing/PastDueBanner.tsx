import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { useOnboardingStatus } from '../../hooks/useOnboardingStatus';
import {
  isCustomerMissing,
  parsePortalFailure,
  type BillingPortalFailure,
} from '../../utils/billing-error';

/**
 * Past-due payment banner. Renders whenever the tenant's Stripe
 * subscription is in `past_due` — surfaced via data.subscriptionStatus,
 * which mirrors tenants.subscription_status (kept fresh by the Stripe
 * customer.subscription.* webhook). No new column: Stripe stays the source
 * of truth for billing state.
 *
 * CTA opens the existing Stripe Customer Portal
 * (POST /api/billing/portal-session → { url }) so the owner can update
 * their card. Not dismissible — a failed payment is a blocking problem the
 * owner needs to resolve, not a nudge.
 */
export function PastDueBanner() {
  const apiFetch = useApiClient();
  const { data } = useOnboardingStatus(60_000);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<BillingPortalFailure | null>(null);

  if (!data || data.subscriptionStatus !== 'past_due') return null;

  async function openPortal() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/billing/portal-session', {
        method: 'POST',
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      if (!res.ok) {
        // #873 — render the server's actionable reason (e.g. the saved
        // Stripe customer no longer exists — contact support to re-link
        // billing) instead of discarding it for a generic HTTP line.
        setError(await parsePortalFailure(res));
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        window.location.href = body.url;
      } else {
        setError({ message: "Couldn't open billing — no portal URL returned." });
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setPending(false);
    }
  }

  // #873 — when the SAVED Stripe customer is gone, opening the portal can
  // never succeed; hide the CTA and render re-link guidance instead.
  const customerMissing = error !== null && isCustomerMissing(error);

  return (
    <div className="border-b border-red-300 bg-red-50 px-4 py-3 text-sm flex items-center gap-3">
      <AlertTriangle size={16} className="shrink-0 text-red-700" />
      <div className="flex-1">
        <span className="font-semibold text-red-900">Your last payment failed.</span>{' '}
        <span className="text-red-800">
          Update your card to keep your AI agent answering calls.
        </span>
        {error && !customerMissing && (
          <span role="alert" className="ml-3 text-red-700">
            {error.message}
          </span>
        )}
        {customerMissing && (
          <span role="alert" className="ml-3 text-red-700" data-testid="past-due-relink">
            The saved Stripe billing record
            {error?.stripeCustomerId && (
              <>
                {' '}
                (<code className="font-mono" data-testid="past-due-stale-id">{error.stripeCustomerId}</code>)
              </>
            )}{' '}
            no longer exists — the account owner needs to contact support to re-link billing
            before the card can be updated.
          </span>
        )}
      </div>
      {!customerMissing && (
        <button
          type="button"
          onClick={() => void openPortal()}
          disabled={pending}
          className="px-3 py-1.5 bg-red-700 text-white rounded text-xs font-medium disabled:opacity-50"
        >
          {pending ? 'Opening…' : 'Update payment method'}
        </button>
      )}
    </div>
  );
}
