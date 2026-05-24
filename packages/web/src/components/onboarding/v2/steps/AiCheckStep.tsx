import { useState } from 'react';
import { useApiClient } from '../../../../lib/apiClient';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface AiCheckStepProps {
  status: OnboardingStatusResponse;
  onRetryComplete?: () => void;
}

const BLOCKER_COPY: Record<string, string> = {
  ai_config_missing: 'No AI model is configured for your account yet.',
  ai_verification_failed: "Your AI assistant didn't respond as expected.",
};

export function AiCheckStep({ status, onRetryComplete }: AiCheckStepProps) {
  const apiFetch = useApiClient();
  const step = status.steps.find((s) => s.id === 'ai_check');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!step) return null;

  if (step.status === 'done') {
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-2xl font-bold text-slate-900">AI verified</h1>
        <div className="flex items-center gap-3 border border-emerald-300 bg-emerald-50 rounded p-4">
          <span className="text-emerald-600 text-lg" aria-hidden>✓</span>
          <p className="text-sm text-emerald-800">
            Your AI assistant is responding correctly.
          </p>
        </div>
      </div>
    );
  }

  if (step.status === 'error') {
    const blocker = (step.blockers ?? [])[0] ?? 'ai_verification_failed';
    const detail = (step.metadata as { error?: string } | undefined)?.error;
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-2xl font-bold text-slate-900">Verify your AI</h1>
        <div className="border border-red-300 bg-red-50 rounded p-4">
          <p className="text-sm text-red-700">{BLOCKER_COPY[blocker] ?? 'AI verification failed.'}</p>
          {detail && <p className="text-xs text-red-600 mt-2">{detail}</p>}
        </div>
        {retryError && <p className="text-sm text-red-600">{retryError}</p>}
        <button
          type="button"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            setRetryError(null);
            try {
              const res = await apiFetch('/api/onboarding/ai-check/retry', { method: 'POST' });
              if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as { message?: string };
                setRetryError(body.message ?? `Retry failed (${res.status})`);
                return;
              }
              onRetryComplete?.();
            } catch (err) {
              setRetryError(err instanceof Error ? err.message : 'Retry failed');
            } finally {
              setRetrying(false);
            }
          }}
          className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry verification'}
        </button>
      </div>
    );
  }

  // pending / current — the 3s poll auto-advances when the worker finishes.
  return (
    <div className="space-y-4 max-w-md">
      <h1 className="text-2xl font-bold text-slate-900">Verify your AI</h1>
      <div className="flex items-center gap-3 border border-slate-200 rounded p-4">
        <div className="size-3 rounded-full bg-blue-500 animate-pulse" />
        <p className="text-sm text-slate-700">
          Verifying your AI assistant… this only takes a moment.
        </p>
      </div>
      <p className="text-xs text-slate-500">
        This page refreshes automatically when the check completes.
      </p>
    </div>
  );
}
