import { useEffect, useState } from 'react';
import { useRivetLine } from '../../../hooks/useRivetVoice';
import { useApiClient } from '../../../lib/apiClient';
import { Button, OptionCard, Spinner } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { CHECKOUT_NO_URL, NETWORK_ERROR, planOption, trialErrorCopy, type BillingPlan } from './trial-copy';

export interface TrialTurnProps {
  /** One line from the payment page (cancelled, or confirming); null when there is none. */
  notice: string | null;
  /** The owner tapped Start and the checkout was requested. */
  onCheckoutRequested: (planId: string) => void;
}

type Plans = { state: 'loading' } | { state: 'ready'; plans: BillingPlan[] } | { state: 'unavailable'; message: string };

const TRIAL_LINE = 'Last thing before your number: start your free trial.';

/**
 * Start the free trial: the real plans, one tap to the payment page. The trial
 * is how the number gets paid for, so there is no way around this turn.
 */
export function TrialTurn({ notice, onCheckoutRequested }: TrialTurnProps) {
  useRivetLine('trial', TRIAL_LINE);
  const apiFetch = useApiClient();
  const [plans, setPlans] = useState<Plans>({ state: 'loading' });
  // Bumped by "Try again" to ask for the plans a second time.
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The payment page's notice is about what happened before; it goes once the owner acts again.
  const [acted, setActed] = useState(false);

  useEffect(() => {
    const request = { cancelled: false };
    setPlans({ state: 'loading' });
    void (async () => {
      try {
        const res = await apiFetch('/api/onboarding/billing/plans');
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          if (!request.cancelled) setPlans({ state: 'unavailable', message: trialErrorCopy('plans', res.status, body.message) });
          return;
        }
        const body = (await res.json()) as { plans?: BillingPlan[] };
        const list = Array.isArray(body.plans) ? body.plans : [];
        if (request.cancelled) return;
        if (list.length === 0) {
          setPlans({ state: 'unavailable', message: trialErrorCopy('plans', 503) });
          return;
        }
        // One plan leaves nothing to choose between; two are the owner's call.
        setSelected(list.length === 1 ? list[0].id : null);
        setPlans({ state: 'ready', plans: list });
      } catch {
        if (!request.cancelled) setPlans({ state: 'unavailable', message: NETWORK_ERROR });
      }
    })();
    return () => {
      request.cancelled = true;
    };
  }, [apiFetch, attempt]);

  const start = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setActed(true);
    setError(null);
    onCheckoutRequested(selected);
    try {
      const res = await apiFetch('/api/onboarding/billing/checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(trialErrorCopy('checkout', res.status, body.message));
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) window.location.href = body.url;
      else setError(CHECKOUT_NO_URL);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      // Also on success: the owner can come back with the browser's Back button to this same page.
      setStarting(false);
    }
  };

  return (
    <>
      <SpeakerLine />
      <RivetHeading>{TRIAL_LINE}</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        It&apos;s free for 14 days, and you can cancel any time in Settings.
      </p>

      {plans.state === 'unavailable' ? (
        <p role="alert" className="mt-5 rounded-2xl border border-border bg-card p-4 text-base leading-[1.45] text-destructive">
          {plans.message}
        </p>
      ) : plans.state === 'loading' ? (
        <div className="mt-5 flex min-h-14 items-center gap-3 text-base text-secondary-foreground">
          <Spinner size="sm" label="Getting the plans" />
          Getting the plans.
        </div>
      ) : (
        <OptionCard
          className="mt-5"
          label="Choose a plan"
          options={plans.plans.map(planOption)}
          value={selected}
          onChange={setSelected}
          disabled={starting}
        />
      )}

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : notice && !acted ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {plans.state === 'unavailable' ? (
          <Button fullWidth size="lg" className="h-14 rounded-2xl text-[17px] font-semibold" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        ) : (
          <Button
            fullWidth
            size="lg"
            className="h-14 whitespace-normal rounded-2xl text-[17px] font-semibold"
            disabled={!selected || plans.state !== 'ready'}
            loading={starting}
            onClick={() => void start()}
          >
            Start my free trial
          </Button>
        )}
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          You&apos;ll add a card on a secure page; nothing is charged for 14 days, and I never see the number.
        </p>
      </div>
    </>
  );
}
