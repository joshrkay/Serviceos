import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '@clerk/clerk-react';
import { toast } from 'sonner';
import { Zap } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { useOnboardingStatus } from '../../../hooks/useOnboardingStatus';
import { track, trackFunnel, type AnalyticsEvent } from '../../../lib/analytics';
import { Button, Spinner } from '../../ui';
import { VoiceBar } from '../../shared/VoiceBar';
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
 * Maps the real wizard steps onto the launch-funnel's spec step names.
 * The real wizard has no standalone "voice" or "calendar" step: the AI
 * self-check (`ai_check`) is the "voice agent works" gate, and calendar is
 * a per-user Google OAuth in settings (no wizard step → wizard_step_calendar
 * is intentionally not emitted; documented in FUNNEL.md). The `pack` and
 * `billing` steps have no spec analog and ride the generic
 * onboarding_step_viewed/completed events with a `step` prop.
 */
const WIZARD_STEP_EVENT: Partial<Record<OnboardingStepId, AnalyticsEvent>> = {
  identity: 'wizard_step_business',
  phone: 'wizard_step_phone',
  ai_check: 'wizard_step_voice',
};

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
  const apiFetch = useApiClient();
  const { userId } = useAuth();
  const { data, isLoading, error, refetch } = useOnboardingStatus(3000);
  const [override, setOverride] = useState<OnboardingStepId | null>(null);
  const billingToastShown = useRef(false);

  // The step the user is currently looking at. Derived the same way as the
  // render-time activeId below, but computed up here (before the early
  // returns) so the funnel effects can depend on it without breaking the
  // rules-of-hooks ordering. null until the first status load.
  const activeStepId: OnboardingStepId | null = override ?? data?.currentStep ?? null;
  const tenantId = data?.tenantId ?? null;

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
      // AWAIT the cleanup so we can tell the operator the truth.
      // If Stripe's expire endpoint transiently fails,
      // /billing/cancel returns non-OK and leaves the pending marker
      // in place — the gate will keep refusing for up to 32 minutes.
      // A fire-and-forget here would have shown the "you can
      // subscribe when ready" toast even when the next click would
      // bounce with "checkout in progress" and no retry signal.
      (async () => {
        try {
          const res = await apiFetch('/api/onboarding/billing/cancel', { method: 'POST' });
          if (res.ok) {
            toast.message('Checkout canceled — you can subscribe when you are ready.');
          } else {
            toast.error(
              "Checkout canceled, but cleanup hit a hiccup. Wait a minute and try again — or contact support if it doesn't clear.",
            );
          }
        } catch {
          toast.error(
            'Checkout canceled, but cleanup didn’t complete. Check your connection and try again in a minute.',
          );
        }
      })();
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
      // Keep the original event firing (downstream dashboards key off it)
      // and add the spec-named wizard_completed alongside it.
      track('onboarding_completed', { voiceAgentLive: data.voiceAgentLive });
      trackFunnel('wizard_completed', { tenantId, userId }, {
        voice_agent_live: data.voiceAgentLive,
      });
    }
  }, [data?.isComplete, data?.voiceAgentLive, tenantId, userId]);

  // wizard_started — fire once, the first time the wizard loads in an
  // incomplete state. Ref-guarded so the 3s poll can't re-fire it.
  const wizardStartedRef = useRef(false);
  useEffect(() => {
    if (!data || data.isComplete) return;
    if (wizardStartedRef.current) return;
    wizardStartedRef.current = true;
    trackFunnel('wizard_started', { tenantId, userId });
  }, [data, tenantId, userId]);

  // Per-step VIEW — fire onboarding_step_viewed (drives abandonment: the
  // last step viewed without a matching completed event is the drop point)
  // plus the mapped spec event (wizard_step_*) when the step has one.
  // Deduped per step id so polling re-renders don't re-fire.
  const viewedStepsRef = useRef<Set<OnboardingStepId>>(new Set());
  useEffect(() => {
    if (!data || !activeStepId) return;
    if (viewedStepsRef.current.has(activeStepId)) return;
    viewedStepsRef.current.add(activeStepId);
    trackFunnel('onboarding_step_viewed', { tenantId, userId }, { step: activeStepId });
    const mapped = WIZARD_STEP_EVENT[activeStepId];
    if (mapped) trackFunnel(mapped, { tenantId, userId }, { step: activeStepId });
  }, [activeStepId, data, tenantId, userId]);

  // Per-step COMPLETION — fire onboarding_step_completed when a step flips
  // to 'done'. The ref is seeded (without firing) on the first observation
  // so a resumed session doesn't replay completions for steps already done
  // before this page load — only genuine in-session transitions emit.
  const completedStepsRef = useRef<Set<OnboardingStepId> | null>(null);
  useEffect(() => {
    if (!data) return;
    if (completedStepsRef.current === null) {
      completedStepsRef.current = new Set(
        data.steps.filter((s) => s.status === 'done').map((s) => s.id),
      );
      return;
    }
    for (const s of data.steps) {
      if (s.status === 'done' && !completedStepsRef.current.has(s.id)) {
        completedStepsRef.current.add(s.id);
        trackFunnel('onboarding_step_completed', { tenantId, userId }, { step: s.id });
      }
    }
  }, [data, tenantId, userId]);

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

  const activeId: OnboardingStepId = activeStepId ?? 'test_call';

  return (
    <div className="flex min-h-screen bg-white">
      <Sidebar status={data} activeId={activeId} onSelect={setOverride} />
      <main className="flex-1">
        <MobileProgress status={data} activeId={activeId} />
        {/* pb-28 leaves room for the fixed voice bar so it never covers a step's CTA. */}
        <div className="p-6 md:p-8 max-w-3xl pb-28">
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
      {/* U6 — the persistent mic is reachable during onboarding and routes voice
          to the conversational onboarding agent (not /assistant). */}
      <div
        data-testid="onboarding-voice-bar"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white shadow-[0_-1px_4px_rgba(0,0,0,0.04)]"
      >
        <div className="mx-auto w-full max-w-3xl">
          <VoiceBar variant="mobile" />
        </div>
      </div>
    </div>
  );
}
