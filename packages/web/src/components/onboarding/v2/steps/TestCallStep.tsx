import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../../../../lib/apiClient';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface TestCallStepProps {
  status: OnboardingStatusResponse;
  onSkipped: () => void;
}

export function TestCallStep({ status, onSkipped }: TestCallStepProps) {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [skipping, setSkipping] = useState(false);

  const step = status.steps.find((s) => s.id === 'test_call');
  if (!step) return null;

  const phoneStep = status.steps.find((s) => s.id === 'phone');
  const phoneNumber =
    ((phoneStep?.metadata ?? {}) as { phoneNumber?: string }).phoneNumber ?? null;

  // Already done or skipped — show the "You're live" moment.
  if (step.status === 'done' || step.status === 'skipped') {
    return (
      <div className="text-center space-y-6 py-16">
        <div className="text-6xl" aria-hidden>
          🎉
        </div>
        <h1 className="text-3xl font-bold text-slate-900">You're live</h1>
        <p className="text-slate-600 max-w-md mx-auto">
          Your AI agent is answering calls.
          {step.status === 'skipped' && ' (Test call skipped — you can call your number anytime to try it.)'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="px-6 py-3 bg-blue-600 text-white rounded text-lg"
        >
          Go to dashboard
        </button>
      </div>
    );
  }

  async function skip() {
    setSkipping(true);
    try {
      const res = await apiFetch('/api/onboarding/test-call/skip', { method: 'POST' });
      if (res.ok) onSkipped();
    } finally {
      setSkipping(false);
    }
  }

  return (
    <div className="space-y-6 max-w-md">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Make a test call</h1>
        <p className="text-sm text-slate-500 mt-1">
          Call this number from your phone right now. We'll detect it and finish setup.
        </p>
      </header>

      <div className="border-2 border-blue-500 rounded-lg p-6 text-center">
        <div className="text-3xl font-mono text-slate-900">
          {phoneNumber ?? '(provisioning…)'}
        </div>
      </div>

      <div className="flex items-center gap-3 text-sm text-slate-600">
        <div className="size-2 rounded-full bg-blue-500 animate-pulse" />
        Waiting for your call…
      </div>

      <button
        type="button"
        onClick={() => void skip()}
        disabled={skipping}
        className="text-sm text-slate-500 underline disabled:opacity-50"
      >
        {skipping ? 'Skipping…' : "Skip — I'll test later"}
      </button>
    </div>
  );
}
