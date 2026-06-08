import { useState } from 'react';
import { Check } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button } from '../../../ui';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface AiCheckStepProps {
  status: OnboardingStatusResponse;
  onRetryComplete?: () => void;
}

const BLOCKER_COPY: Record<string, string> = {
  ai_config_missing:
    "Your AI model isn't configured. This usually self-heals on retry — if it doesn't, contact support.",
  ai_verification_failed:
    "Your AI didn't respond as expected. Hit Retry and we'll send the test prompt again.",
};

export function AiCheckStep({ status, onRetryComplete }: AiCheckStepProps) {
  const apiFetch = useApiClient();
  const step = status.steps.find((s) => s.id === 'ai_check');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

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
        <Button
          variant="primary"
          size="lg"
          loading={retrying}
          onClick={async () => {
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
          }}
        >
          {retrying ? 'Retrying…' : 'Retry verification'}
        </Button>
      </div>
    );
  }

  // pending / current — the 3s poll auto-advances when the worker finishes.
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
    </div>
  );
}
