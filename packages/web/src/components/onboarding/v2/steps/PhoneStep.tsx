import { useState } from 'react';
import { useApiClient } from '../../../../lib/apiClient';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface PhoneStepProps {
  status: OnboardingStatusResponse;
  onAdvance: () => void;
  onRetryComplete?: () => void;
}

interface CarrierTip {
  name: string;
  code: string;
  note?: string;
}

const CARRIERS: CarrierTip[] = [
  { name: 'Verizon', code: '*72' },
  { name: 'AT&T', code: '*72' },
  { name: 'T-Mobile', code: '**21*' },
  { name: 'Other', code: 'Ask your carrier', note: 'Most carriers support unconditional call forwarding.' },
];

export function PhoneStep({ status, onAdvance, onRetryComplete }: PhoneStepProps) {
  const apiFetch = useApiClient();
  const phoneStep = status.steps.find((s) => s.id === 'phone');
  const meta = (phoneStep?.metadata ?? {}) as { phoneNumber?: string };
  const phoneNumber = meta.phoneNumber ?? null;
  const [forwardingOpen, setForwardingOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!phoneStep) return null;

  if (phoneStep.status === 'error') {
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-2xl font-bold text-slate-900">Phone number</h1>
        <div className="border border-red-300 bg-red-50 rounded p-4">
          <p className="text-sm text-red-700">
            We hit an issue purchasing your number. Our team has been alerted.
          </p>
          <p className="text-xs text-red-600 mt-2">
            {(phoneStep.blockers ?? []).join(', ') || 'twilio_provisioning_failed'}
          </p>
        </div>
        {retryError && (
          <p className="text-sm text-red-600">{retryError}</p>
        )}
        <button
          type="button"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            setRetryError(null);
            try {
              const res = await apiFetch('/api/onboarding/phone/retry', { method: 'POST' });
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
          {retrying ? 'Retrying…' : 'Retry provisioning'}
        </button>
      </div>
    );
  }

  if (phoneStep.status !== 'done' && phoneStep.status !== 'current') {
    return null;
  }

  if (!phoneNumber) {
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-2xl font-bold text-slate-900">Phone number</h1>
        <div className="flex items-center gap-3 border border-slate-200 rounded p-4">
          <div className="size-3 rounded-full bg-blue-500 animate-pulse" />
          <p className="text-sm text-slate-700">
            We're claiming your phone number… usually takes about 30 seconds.
          </p>
        </div>
        <p className="text-xs text-slate-500">
          This page refreshes automatically when the number is ready.
        </p>
      </div>
    );
  }

  async function copy() {
    if (!phoneNumber) return;
    try {
      await navigator.clipboard.writeText(phoneNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort — some browsers gate clipboard on non-https origins.
    }
  }

  return (
    <div className="space-y-6 max-w-md">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Your phone number is ready</h1>
        <p className="text-sm text-slate-500 mt-1">
          Forward your existing business line to it, or share it with new customers directly.
        </p>
        <p className="text-sm text-amber-800 mt-2">
          Your number is ready. AI will not answer until you turn it on after billing.
        </p>
      </header>

      <div className="border-2 border-blue-500 rounded-lg p-6 text-center">
        <div className="text-3xl font-mono text-slate-900">{phoneNumber}</div>
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-3 text-sm text-blue-600 hover:underline"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <button
        type="button"
        onClick={() => setForwardingOpen((v) => !v)}
        className="text-sm text-slate-700 underline"
      >
        {forwardingOpen ? 'Hide' : 'Show'} forwarding instructions
      </button>

      {forwardingOpen && (
        <div className="border border-slate-200 rounded p-4 space-y-3 text-sm">
          <p className="text-slate-700">
            Dial the carrier code from your existing business line to forward all incoming calls to the new number.
          </p>
          <ul className="space-y-2">
            {CARRIERS.map((c) => (
              <li key={c.name} className="flex justify-between gap-3">
                <span className="font-medium text-slate-700">{c.name}</span>
                <span className="text-slate-600">
                  <span className="font-mono">{c.code}</span>
                  {phoneNumber && c.code !== 'Ask your carrier' && (
                    <> + {phoneNumber.replace(/^\+1/, '')}</>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onAdvance}
          className="px-4 py-2 bg-blue-600 text-white rounded"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
