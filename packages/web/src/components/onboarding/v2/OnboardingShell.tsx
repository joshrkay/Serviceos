import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Zap } from 'lucide-react';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { track } from '../../../lib/analytics';
import { Button, Spinner } from '../../ui';
import { Sidebar } from './Sidebar';
import { MobileProgress } from './MobileProgress';
import { IdentityStep } from './steps/IdentityStep';
import { PackStep } from './steps/PackStep';
import { PhoneStep } from './steps/PhoneStep';
import { BillingStep } from './steps/BillingStep';
import { AiCheckStep } from './steps/AiCheckStep';
import { TestCallStep } from './steps/TestCallStep';
import type { OnboardingStepId } from '../../../types/onboarding';

/**
 * §10 onboarding shell — sidebar + main pane.
 *
 * Polls /api/onboarding/status every 3s so phone-provisioning, test-call
 * detection, and Stripe-webhook updates feel real-time without manual
 * refresh. Resumability is derived from real entities (no
 * onboarding_progress table) — see packages/api/src/onboarding/derive-status.ts.
 */
export function OnboardingShell() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, error, refetch } = useOnboardingStatus(3000);
  const [override, setOverride] = useState<OnboardingStepId | null>(null);
  const billingToastShown = useRef(false);

  useEffect(() => {
    const billing = searchParams.get('billing');
    if (!billing || billingToastShown.current) return;
    billingToastShown.current = true;
    if (billing === 'ok') {
      toast.success('Trial started — your card is on file for after the 14-day trial.');
      // trial_started is captured server-side from the Stripe
      // customer.subscription.* webhook (see webhooks/routes.ts). Firing
      // it here too would double-count every checkout redirect in the
      // funnel since both paths run on a normal completed checkout.
      void refetch();
    } else if (billing === 'cancel') {
      toast.message('Checkout canceled — you can subscribe when you are ready.');
    }
    const next = new URLSearchParams(searchParams);
    next.delete('billing');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refetch]);

  // Fire exactly on the incomplete → complete transition, never on a
  // "complete on first load" revisit. The previous ref-only guard
  // counted every refresh of an already-finished tenant as a new
  // completion. We track the prior value across renders and only emit
  // when isComplete flips true after having been observed as not-true.
  const wasIncompleteRef = useRef(false);
  useEffect(() => {
    if (data?.isComplete === false) {
      wasIncompleteRef.current = true;
      return;
    }
    if (data?.isComplete && wasIncompleteRef.current) {
      wasIncompleteRef.current = false;
      track('onboarding_completed', { voiceAgentLive: data.voiceAgentLive });
    }
  }, [data?.isComplete, data?.voiceAgentLive]);

  if (isLoading && !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-slate-500">
          <span className="flex size-10 items-center justify-center rounded-xl bg-slate-900">
            <Zap size={18} className="text-white" />
          </span>
          <Spinner size="md" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <h1 className="text-lg font-medium text-slate-900">We couldn&apos;t load your setup</h1>
          <p className="mt-2 text-sm text-slate-500">
            Check your connection and try again. If this keeps happening, contact support.
          </p>
          <div className="mt-5 flex justify-center">
            <Button variant="primary" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Once complete, bounce to dashboard. The app-shell guard would
  // already block re-entry, but this guards against a user landing on
  // /onboarding directly after finishing.
  if (data.isComplete && !override) {
    navigate('/', { replace: true });
    return null;
  }

  const activeId: OnboardingStepId = override ?? data.currentStep ?? 'test_call';

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar status={data} activeId={activeId} onSelect={setOverride} />
      <main className="flex-1">
        <MobileProgress status={data} activeId={activeId} />
        <div className="p-6 md:p-8 max-w-3xl">
          {activeId === 'identity' && <IdentityStep onSaved={() => void refetch()} />}
          {activeId === 'pack' && <PackStep onSaved={() => void refetch()} />}
          {activeId === 'phone' && (
            <PhoneStep
              status={data}
              onAdvance={() => setOverride('billing')}
              onRetryComplete={() => void refetch()}
            />
          )}
          {activeId === 'billing' && <BillingStep />}
          {activeId === 'ai_check' && (
            <AiCheckStep status={data} onRetryComplete={() => void refetch()} />
          )}
          {activeId === 'test_call' && (
            <TestCallStep
              status={data}
              onSkipped={() => void refetch()}
              onRefresh={() => void refetch()}
            />
          )}
          {activeId === 'signup' && (
            <div className="text-slate-500">
              <h1 className="text-2xl font-medium tracking-tight text-slate-900 mb-2">Signed in</h1>
              <p>Your account is created. Move on to business identity.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
