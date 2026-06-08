import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '@clerk/clerk-react';
import { Phone, Copy, Check } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button } from '../../../ui';
import { track, trackFunnel } from '../../../../lib/analytics';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface TestCallStepProps {
  status: OnboardingStatusResponse;
  onSkipped: () => void;
  onRefresh: () => void;
}

function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

export function TestCallStep({ status, onSkipped, onRefresh }: TestCallStepProps) {
  const apiFetch = useApiClient();
  const navigate = useNavigate();
  const { userId } = useAuth();
  const [skipping, setSkipping] = useState(false);
  const [goingLive, setGoingLive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);

  const step = status.steps.find((s) => s.id === 'test_call');
  const phoneStep = status.steps.find((s) => s.id === 'phone');
  const phoneNumber = ((phoneStep?.metadata ?? {}) as { phoneNumber?: string }).phoneNumber ?? null;
  const formatted = formatPhone(phoneNumber);
  const telHref = phoneNumber ? `tel:${phoneNumber.replace(/[^\d+]/g, '')}` : undefined;
  const voiceAgentLive = status.voiceAgentLive;

  // test_call_initiated — the user's intent-to-call moment (tapping the
  // tel: link or copying the number). Fired at most once per mount.
  const initiatedRef = useRef(false);
  function markTestCallInitiated() {
    if (initiatedRef.current) return;
    initiatedRef.current = true;
    trackFunnel('test_call_initiated', { tenantId: status.tenantId, userId });
  }

  // test_call_succeeded — fires when the server detects the inbound test
  // call and flips the step to 'done'. Seeded on first observation so a
  // resumed (already-done) session doesn't replay the event.
  const succeededFiredRef = useRef(false);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const s = step?.status ?? null;
    const prev = prevStatusRef.current;
    prevStatusRef.current = s;
    if (s === 'done' && prev !== null && prev !== 'done' && !succeededFiredRef.current) {
      succeededFiredRef.current = true;
      trackFunnel('test_call_succeeded', { tenantId: status.tenantId, userId });
    }
  }, [step?.status, status.tenantId, userId]);

  // Surface a "still waiting" cue after 60s so the user knows they may
  // need to redial or skip.
  useEffect(() => {
    if (!step) return;
    if (step.status === 'done' || step.status === 'skipped') return;
    const t = setTimeout(() => setWaitedLong(true), 60_000);
    return () => clearTimeout(t);
  }, [step?.status]);

  if (!step) return null;

  async function turnOnAiAnswering() {
    setGoingLive(true);
    try {
      const res = await apiFetch('/api/voice/go-live', { method: 'POST' });
      if (res.ok) {
        track('voice_agent_turned_on');
        onRefresh();
      }
    } finally {
      setGoingLive(false);
    }
  }

  async function copy() {
    if (!phoneNumber) return;
    markTestCallInitiated();
    try {
      await navigator.clipboard.writeText(phoneNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort; clipboard may be gated on non-https origins.
    }
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

  // ── Done state — onboarding complete ────────────────────────────────
  if (step.status === 'done' || step.status === 'skipped') {
    const title = voiceAgentLive ? "You're live" : 'Setup complete';
    return (
      <div className="mx-auto max-w-md space-y-6 py-12 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-slate-900 text-white">
          {voiceAgentLive ? <Phone size={22} /> : <Check size={22} />}
        </div>
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-slate-900">{title}</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm text-slate-600">
            {voiceAgentLive ? (
              <>
                Your AI dispatcher is answering calls.
                {step.status === 'skipped' &&
                  ' (You skipped the test call — feel free to call your number anytime to try it.)'}
              </>
            ) : (
              <>
                Onboarding is finished, but AI answering is still off. Turn it on whenever
                you&apos;re ready to forward your line.
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-center gap-3">
          {!voiceAgentLive && (
            <Button variant="primary" size="lg" loading={goingLive} onClick={() => void turnOnAiAnswering()}>
              {goingLive ? 'Turning on…' : 'Turn on AI answering'}
            </Button>
          )}
          <Button variant="outline" size="lg" onClick={() => navigate('/', { replace: true })}>
            Go to dashboard
          </Button>
        </div>
      </div>
    );
  }

  // ── Active — waiting for the test call ──────────────────────────────
  return (
    <div className="space-y-7 max-w-md">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">Make a test call</h1>
        <p className="text-sm text-slate-500 mt-2">
          Call your Rivet number from your phone. We&apos;ll detect it and let you turn on AI
          answering for real.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-center gap-2 text-slate-500">
          <Phone size={14} />
          <span className="text-xs uppercase tracking-widest">Call this number</span>
        </div>
        {phoneNumber ? (
          <a
            href={telHref}
            onClick={markTestCallInitiated}
            className="mt-3 block text-center text-3xl font-medium tracking-tight text-slate-900 hover:underline"
          >
            {formatted || phoneNumber}
          </a>
        ) : (
          <p className="mt-3 text-center text-3xl font-medium tracking-tight text-slate-400">
            (provisioning…)
          </p>
        )}
        {phoneNumber && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              leftIcon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy number'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        <div className="size-2 rounded-full bg-slate-900 animate-pulse" />
        {waitedLong ? (
          <span>
            No call detected yet. Try calling again — or skip and turn it on manually.
          </span>
        ) : (
          <span>Waiting for your call…</span>
        )}
      </div>

      {voiceAgentLive ? (
        <p className="text-sm font-medium text-green-700">AI answering is on</p>
      ) : (
        <Button variant="primary" size="lg" loading={goingLive} onClick={() => void turnOnAiAnswering()} fullWidth>
          {goingLive ? 'Turning on…' : 'Turn on AI answering'}
        </Button>
      )}

      <Button
        variant="ghost"
        size="sm"
        loading={skipping}
        onClick={() => void skip()}
        className="text-slate-500"
      >
        {skipping ? 'Skipping…' : "Skip — I'll test later"}
      </Button>
    </div>
  );
}
