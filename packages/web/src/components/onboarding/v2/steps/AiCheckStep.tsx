import { useState } from 'react';
import { Check } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button } from '../../../ui';
import { VoiceConfigPanel } from '../VoiceConfigPanel';
import { VoiceApprovalPinPanel } from '../VoiceApprovalPinPanel';
import type { OnboardingStatusResponse, OnboardingStepId } from '../../../../types/onboarding';

interface AiCheckStepProps {
  status: OnboardingStatusResponse;
  onRetryComplete?: () => void;
  /** #1282 — jump the stepper to the step that is blocking the AI check. */
  onGoToStep?: (id: OnboardingStepId) => void;
}

const BLOCKING_STEP_LABEL: Partial<Record<OnboardingStepId, string>> = {
  identity: 'Business identity',
  pack: 'Pick your trade',
  phone: 'Phone number',
  billing: 'Start trial',
};

const BLOCKER_COPY: Record<string, string> = {
  ai_config_missing:
    "Your AI model isn't configured. This usually self-heals on retry — if it doesn't, contact support.",
  ai_verification_failed:
    "Your AI didn't respond as expected. Hit Retry and we'll send the test prompt again.",
};

export function AiCheckStep({ status, onRetryComplete, onGoToStep }: AiCheckStepProps) {
  const apiFetch = useApiClient();
  const step = status.steps.find((s) => s.id === 'ai_check');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);

  /**
   * Escape hatch: a failed or flaky verification must never trap the tenant
   * in incomplete setup. Skipping completes the ai_check step; verification
   * stays retryable — the Settings page surfaces it as a checklist item
   * with a retry action.
   */
  async function skipForNow() {
    setSkipping(true);
    setRetryError(null);
    try {
      const res = await apiFetch('/api/onboarding/ai-check/skip', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setRetryError(body.message ?? `Skip failed (HTTP ${res.status})`);
        return;
      }
      onRetryComplete?.();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Skip failed. Check your connection.');
    } finally {
      setSkipping(false);
    }
  }

  async function retryVerification() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await apiFetch('/api/onboarding/ai-check/retry', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setRetryError(body.message ?? `Retry failed (HTTP ${res.status})`);
        return;
      }
      onRetryComplete?.();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed. Check your connection.');
    } finally {
      setRetrying(false);
    }
  }

  if (!step) return null;

  if (step.status === 'done') {
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">AI verified</h1>
        </header>
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
            <Check size={14} />
          </div>
          <p className="text-sm text-emerald-800">
            Your AI assistant answered the test prompt correctly. Ready to take real calls.
          </p>
        </div>
        <VoiceConfigPanel />
        <VoiceApprovalPinPanel />
      </div>
    );
  }

  if (step.status === 'error') {
    const blocker = (step.blockers ?? [])[0] ?? 'ai_verification_failed';
    const detail = (step.metadata as { error?: string } | undefined)?.error;
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">Verify your AI</h1>
        </header>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{BLOCKER_COPY[blocker] ?? 'AI verification failed.'}</p>
          {detail && <p className="mt-2 text-xs text-red-600">{detail}</p>}
        </div>
        {retryError && <p className="text-sm text-red-600">{retryError}</p>}
        <div className="space-y-3">
          <Button
            variant="primary"
            size="lg"
            loading={retrying}
            onClick={retryVerification}
          >
            {retrying ? 'Retrying…' : 'Retry verification'}
          </Button>
          <div>
            <button
              type="button"
              onClick={skipForNow}
              disabled={skipping}
              className="text-sm text-slate-500 underline underline-offset-2 hover:text-slate-700 disabled:opacity-50"
            >
              {skipping ? 'Skipping…' : 'Skip for now'}
            </button>
            <p className="mt-1 text-xs text-slate-400">
              Finish setup and re-run the check later from Settings.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Skipped via the escape hatch — revisiting the step shows what happened
  // and offers the retry, rather than the misleading "running" spinner.
  if (step.status === 'skipped') {
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">AI check skipped</h1>
          <p className="text-sm text-slate-500 mt-2">
            You finished setup without the AI check. Re-run it here, or any time from Settings.
          </p>
        </header>
        {retryError && <p className="text-sm text-red-600">{retryError}</p>}
        <Button
          variant="primary"
          size="lg"
          loading={retrying}
          onClick={retryVerification}
        >
          {retrying ? 'Retrying…' : 'Retry verification'}
        </Button>
      </div>
    );
  }

  // #1282 — 'pending' means an EARLIER step isn't done yet (the verify worker
  // only runs once a plan exists), so nothing is running and polling would
  // spin forever. Fail fast and point at the step that's actually blocking.
  if (step.status === 'pending') {
    const blocking = status.currentStep;
    const blockingLabel = blocking ? BLOCKING_STEP_LABEL[blocking] : undefined;
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">Verify your AI</h1>
          <p className="text-sm text-slate-500 mt-2">
            We check your AI right after your trial starts. Finish the earlier steps first — nothing
            is running yet.
          </p>
        </header>
        {blocking && blockingLabel && onGoToStep && (
          <Button variant="primary" size="lg" onClick={() => onGoToStep(blocking)}>
            {`Go to ${blockingLabel}`}
          </Button>
        )}
      </div>
    );
  }

  // current — the 3s poll auto-advances when the worker finishes.
  return (
    <div className="space-y-5 max-w-md">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Verifying your AI</h1>
        <p className="text-sm text-slate-500 mt-2">
          We send a short test prompt to make sure your AI is responding correctly before
          it answers a real call.
        </p>
      </header>
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="size-2 rounded-full bg-slate-900 animate-pulse" />
        <p className="text-sm text-slate-700">Running the check… usually a few seconds.</p>
      </div>
      <p className="text-xs text-slate-500">This page refreshes automatically when the check completes.</p>
      {retryError && <p className="text-sm text-red-600">{retryError}</p>}
      <div>
        <button
          type="button"
          onClick={skipForNow}
          disabled={skipping}
          className="text-sm text-slate-500 underline underline-offset-2 hover:text-slate-700 disabled:opacity-50"
        >
          {skipping ? 'Skipping…' : 'Skip for now'}
        </button>
        <p className="mt-1 text-xs text-slate-400">
          Stuck? Finish setup and re-run the check later from Settings.
        </p>
      </div>
      <VoiceConfigPanel />
      <VoiceApprovalPinPanel />
    </div>
  );
}
