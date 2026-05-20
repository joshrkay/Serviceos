import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { Sidebar } from './Sidebar';
import { IdentityStep } from './steps/IdentityStep';
import { PackStep } from './steps/PackStep';
import { PhoneStep } from './steps/PhoneStep';
import { BillingStep } from './steps/BillingStep';
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
      void refetch();
    } else if (billing === 'cancel') {
      toast.message('Checkout canceled — you can subscribe when you are ready.');
    }
    const next = new URLSearchParams(searchParams);
    next.delete('billing');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refetch]);

  if (isLoading && !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center text-slate-500">
        Loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-3">Couldn't load onboarding status.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="px-4 py-2 bg-blue-600 text-white rounded"
          >
            Retry
          </button>
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
      <main className="flex-1 p-8 max-w-3xl">
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
        {activeId === 'test_call' && (
          <TestCallStep status={data} onSkipped={() => void refetch()} />
        )}
        {activeId === 'signup' && (
          <div className="text-slate-500">
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Signed in</h1>
            <p>Your account is created. Move on to business identity.</p>
          </div>
        )}
      </main>
    </div>
  );
}
