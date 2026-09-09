import { useEffect, useState, type KeyboardEvent } from 'react';
import { Check, ArrowRight, Loader2 } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button } from '../../../ui';

type PlanId = 'basic' | 'enterprise';

interface BillingPlan {
  id: PlanId;
  name: string;
  amountCents: number;
  currency: string;
  interval: string;
}

/**
 * A raw `message` is the API's own safe, non-secret, actionable text
 * (see routes/onboarding.ts billing handlers) — surface it verbatim when
 * present. Generic 5xx falls back to a neutral "checkout unavailable"
 * message rather than blaming Stripe specifically: the failure could be
 * our own backend, not necessarily a Stripe outage.
 */
function friendlyBillingError(status: number, raw?: string): string {
  if (status === 503) return raw || 'Billing is not configured for this environment. Contact support to enable billing.';
  if (status === 400) return raw || 'Something looks off with the billing request. Try again or contact support.';
  if (status >= 500) return 'Checkout is temporarily unavailable. Wait a minute and try again.';
  return raw || `Couldn't start checkout (HTTP ${status}).`;
}

function formatAmount(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(amountCents / 100);
}

export function BillingStep() {
  const apiFetch = useApiClient();
  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/onboarding/billing/plans');
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          if (!cancelled) setPlansError(friendlyBillingError(res.status, body.message));
          return;
        }
        const body = (await res.json()) as { plans?: BillingPlan[] };
        if (!cancelled) setPlans(body.plans ?? []);
      } catch (err) {
        if (!cancelled) {
          setPlansError(err instanceof Error ? err.message : 'Network error. Check your connection and try again.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // Native radio inputs give browsers built-in arrow-key navigation, but
  // jsdom (our test environment) doesn't implement that UA behavior, so
  // we drive it ourselves — this also keeps the behavior consistent and
  // testable rather than depending on browser default actions.
  function handlePlanKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    if (!plans || pending) return;
    const isNext = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const isPrev = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!isNext && !isPrev) return;
    event.preventDefault();
    const nextIndex = (index + (isNext ? 1 : -1) + plans.length) % plans.length;
    const nextPlan = plans[nextIndex];
    setSelectedPlan(nextPlan.id);
    document.getElementById(`billing-plan-${nextPlan.id}`)?.focus();
  }

  async function start() {
    if (!selectedPlan) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch('/api/onboarding/billing/checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selectedPlan }),
      });
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
          Choose a plan. Cancel anytime in Settings. We hold a card to keep your AI on after day 14 — nothing charges until then.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <p className="text-xs uppercase tracking-widest text-slate-500">What you get today</p>
        <ul className="mt-3 space-y-2 text-sm text-slate-700">
          {[
            'Set up AI phone answering during onboarding',
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

      {plansError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {plansError}
        </div>
      )}

      {!plansError && plans === null && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading plans…
        </div>
      )}

      {!plansError && plans !== null && (
        <div role="radiogroup" aria-label="Choose a billing plan" className="grid grid-cols-1 gap-3">
          {plans.map((plan, index) => {
            const selected = selectedPlan === plan.id;
            const inputId = `billing-plan-${plan.id}`;
            return (
              <label
                key={plan.id}
                htmlFor={inputId}
                className={`flex min-h-11 items-center justify-between gap-3 rounded-2xl border p-4 transition ${
                  selected
                    ? 'border-slate-900 ring-1 ring-slate-900'
                    : 'border-slate-200 hover:border-slate-400'
                } ${pending ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    id={inputId}
                    name="billing-plan"
                    value={plan.id}
                    checked={selected}
                    disabled={pending}
                    onChange={() => setSelectedPlan(plan.id)}
                    onKeyDown={(event) => handlePlanKeyDown(event, index)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="text-base font-medium text-slate-900">{plan.name}</span>
                </span>
                <span className="text-sm text-slate-600">
                  {formatAmount(plan.amountCents, plan.currency)}/{plan.interval}
                </span>
              </label>
            );
          })}
        </div>
      )}

      <Button
        variant="primary"
        size="lg"
        loading={pending}
        disabled={!selectedPlan || pending}
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
