import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../../../../lib/apiClient';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface TestCallStepProps {
  status: OnboardingStatusResponse;
  onSkipped: () => void;
  onRefresh: () => void;
}

export function TestCallStep({ status, onSkipped, onRefresh }: TestCallStepProps) {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const [skipping, setSkipping] = useState(false);
  const [goingLive, setGoingLive] = useState(false);

  const step = status.steps.find((s) => s.id === 'test_call');
  if (!step) return null;

  const phoneStep = status.steps.find((s) => s.id === 'phone');
  const phoneNumber =
    ((phoneStep?.metadata ?? {}) as { phoneNumber?: string }).phoneNumber ?? null;
  const voiceAgentLive = status.voiceAgentLive;

  async function turnOnAiAnswering() {
    setGoingLive(true);
    try {
      const res = await apiFetch('/api/voice/go-live', { method: 'POST' });
      if (res.ok) onRefresh();
    } finally {
      setGoingLive(false);
    }
  }

  if (step.status === 'done' || step.status === 'skipped') {
    const title = voiceAgentLive ? "You're live" : 'Setup complete';
    return (
      <div className="text-center space-y-6 py-16">
        <div className="text-6xl" aria-hidden>
          {voiceAgentLive ? '🎉' : '✓'}
        </div>
        <h1 className="text-3xl font-bold text-slate-900">{title}</h1>
        <p className="text-slate-600 max-w-md mx-auto">
          {voiceAgentLive ? (
            <>
              Your AI agent is answering calls.
              {step.status === 'skipped' &&
                ' (Test call skipped — you can call your number anytime to try it.)'}
            </>
          ) : (
            <>
              Onboarding is finished, but AI phone answering is still off. Turn it on when you are
              ready to forward your line.
            </>
          )}
        </p>
        {!voiceAgentLive && (
          <button
            type="button"
            onClick={() => void turnOnAiAnswering()}
            disabled={goingLive}
            className="px-6 py-3 bg-blue-600 text-white rounded text-lg disabled:opacity-50"
          >
            {goingLive ? 'Turning on…' : 'Turn on AI answering'}
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="px-6 py-3 border border-slate-300 text-slate-800 rounded text-lg"
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
          Call this number from your phone. We will detect it and can turn on AI answering
          automatically after your first successful call.
        </p>
      </header>

      <div className="border-2 border-blue-500 rounded-lg p-6 text-center space-y-3">
        {phoneNumber ? (
          <a
            href={`tel:${phoneNumber.replace(/\s/g, '')}`}
            className="block text-3xl font-mono text-blue-700 hover:underline"
          >
            {phoneNumber}
          </a>
        ) : (
          <p className="text-3xl font-mono text-slate-900">(provisioning…)</p>
        )}
        {phoneNumber && (
          <button
            type="button"
            className="text-xs text-slate-500 underline"
            onClick={() => {
              void navigator.clipboard.writeText(phoneNumber);
            }}
          >
            Copy number
          </button>
        )}
      </div>

      {voiceAgentLive ? (
        <p className="text-sm text-green-700 font-medium">AI answering is on</p>
      ) : (
        <button
          type="button"
          onClick={() => void turnOnAiAnswering()}
          disabled={goingLive}
          className="w-full px-4 py-3 bg-blue-600 text-white rounded font-medium disabled:opacity-50"
        >
          {goingLive ? 'Turning on…' : 'Turn on AI answering'}
        </button>
      )}

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
