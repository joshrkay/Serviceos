import { useEffect, useState } from 'react';
import { Phone, Copy, Check } from 'lucide-react';
import { useApiClient } from '../../../../lib/apiClient';
import { Button, Input, cn } from '../../../ui';
import type { OnboardingStatusResponse } from '../../../../types/onboarding';

interface PhoneStepProps {
  status: OnboardingStatusResponse;
  onAdvance: () => void;
  onRetryComplete?: () => void;
}

interface CarrierTip {
  name: string;
  /**
   * Returns the full dial string the operator should punch into their
   * existing phone — prefix, the national 10-digit number, and any
   * carrier-specific terminator. The function form lets each carrier
   * compose its own format (e.g. T-Mobile's `**21*1<number>#` has a
   * leading 1 and a trailing #, neither of which fits the simple
   * "prefix + number" pattern Verizon/AT&T use).
   */
  formatCode: (national: string) => string;
  note?: string;
}

const CARRIERS: CarrierTip[] = [
  { name: 'Verizon',  formatCode: (n) => n ? `*72 ${n}` : '*72' },
  { name: 'AT&T',     formatCode: (n) => n ? `*72 ${n}` : '*72' },
  // T-Mobile per support.t-mobile.com short-code table: unconditional
  // forwarding is `**21*1+PhoneNumber#` — needs the leading 1 and
  // the trailing # to register the forward.
  { name: 'T-Mobile', formatCode: (n) => n ? `**21*1${n}#` : '**21*1...#' },
  { name: 'Other',    formatCode: () => 'Ask your carrier', note: 'Most US carriers support unconditional call forwarding.' },
];

const BLOCKER_COPY: Record<string, string> = {
  twilio_provisioning_failed:
    "We couldn't claim a phone number for you. Our team has been alerted.",
  twilio_credentials_missing:
    'Twilio is not configured for this environment. Contact support to enable phone provisioning.',
  area_code_unavailable:
    'No numbers were available in the area code we tried. Hit Retry — we will try the next one.',
  rate_limited:
    'Too many provisioning attempts. Hit Retry in a minute and we will try again.',
};

/** Render +15125551234 → (512) 555-1234 for US numbers. */
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

function nationalDigits(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

interface NumberCandidate {
  phoneNumber: string;
  locality?: string;
  region?: string;
}

/**
 * Number picker: search Twilio by area code and claim a specific local
 * number. The (costly) purchase happens server-side in the provisioning
 * worker — this only lists candidates and submits the chosen E.164.
 * `onClaimed` refreshes onboarding status so the parent re-renders into the
 * "claiming…/ready" states once the worker runs.
 */
function NumberPicker({
  apiFetch,
  onClaimed,
}: {
  apiFetch: ReturnType<typeof useApiClient>;
  onClaimed: () => void;
}) {
  const [areaCode, setAreaCode] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<NumberCandidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const validAreaCode = /^\d{3}$/.test(areaCode);

  async function search() {
    if (!validAreaCode) {
      setSearchError('Enter a 3-digit area code.');
      return;
    }
    setSearching(true);
    setSearchError(null);
    setSelected(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/available', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ areaCode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setCandidates([]);
        setSearched(true);
        setSearchError(
          body.error === 'TWILIO_NOT_CONFIGURED'
            ? 'Number search is unavailable right now — you can let us pick one for you below.'
            : body.message ?? `Search failed (HTTP ${res.status})`,
        );
        return;
      }
      const body = (await res.json()) as { numbers?: NumberCandidate[] };
      setCandidates(body.numbers ?? []);
      setSearched(true);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed. Check your connection.');
    } finally {
      setSearching(false);
    }
  }

  async function claim() {
    if (!selected) return;
    setClaiming(true);
    setClaimError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setClaimError(body.message ?? `Couldn't claim that number (HTTP ${res.status})`);
        return;
      }
      onClaimed();
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed. Check your connection.');
    } finally {
      setClaiming(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
      <div>
        <h2 className="text-sm font-medium text-slate-900">Pick your own number</h2>
        <p className="mt-1 text-xs text-slate-600">
          Search by area code and choose the local number your customers will see.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-slate-700">Area code</span>
          <Input
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
            inputMode="numeric"
            placeholder="512"
            aria-label="Area code"
            className="min-h-11"
          />
        </label>
        <Button
          variant="secondary"
          size="lg"
          className="min-h-11"
          loading={searching}
          disabled={!validAreaCode || searching}
          onClick={() => void search()}
        >
          Search
        </Button>
      </div>

      {searchError && <p className="text-sm text-red-600">{searchError}</p>}

      {searched && !searchError && candidates.length === 0 && (
        <p className="text-sm text-slate-600">
          No numbers free in {areaCode} right now — try another area code.
        </p>
      )}

      {candidates.length > 0 && (
        <>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200">
            {candidates.map((c) => {
              const isSel = selected === c.phoneNumber;
              return (
                <li key={c.phoneNumber}>
                  <button
                    type="button"
                    onClick={() => setSelected(c.phoneNumber)}
                    aria-pressed={isSel}
                    className={cn(
                      'flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left',
                      'hover:bg-slate-50',
                      isSel && 'bg-slate-900/5 ring-2 ring-inset ring-slate-900',
                    )}
                  >
                    <span className="font-medium text-slate-800">{formatPhone(c.phoneNumber)}</span>
                    {(c.locality || c.region) && (
                      <span className="text-xs text-slate-500">
                        {[c.locality, c.region].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {claimError && <p className="text-sm text-red-600">{claimError}</p>}
          <Button
            variant="primary"
            size="lg"
            fullWidth
            className="min-h-11"
            loading={claiming}
            disabled={!selected || claiming}
            onClick={() => void claim()}
          >
            {selected ? `Claim ${formatPhone(selected)}` : 'Select a number'}
          </Button>
        </>
      )}
    </section>
  );
}

export function PhoneStep({ status, onAdvance, onRetryComplete }: PhoneStepProps) {
  const apiFetch = useApiClient();
  const phoneStep = status.steps.find((s) => s.id === 'phone');
  const meta = (phoneStep?.metadata ?? {}) as { phoneNumber?: string };
  const phoneNumber = meta.phoneNumber ?? null;
  const formatted = formatPhone(phoneNumber);
  const national = nationalDigits(phoneNumber);
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [waitedLong, setWaitedLong] = useState(false);

  // After 30s of provisioning, surface a "still working" cue so the
  // user knows it isn't frozen.
  useEffect(() => {
    if (phoneNumber) return;
    if (phoneStep?.status !== 'current' && phoneStep?.status !== 'pending') return;
    const t = setTimeout(() => setWaitedLong(true), 30_000);
    return () => clearTimeout(t);
  }, [phoneNumber, phoneStep?.status]);

  if (!phoneStep) return null;

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

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/retry', { method: 'POST' });
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

  // ── Error: provisioning failed ─────────────────────────────────────
  if (phoneStep.status === 'error') {
    const code = (phoneStep.blockers ?? [])[0] ?? 'twilio_provisioning_failed';
    const friendly = BLOCKER_COPY[code] ?? 'Something went wrong claiming your number. Pick one below, or let us try again.';
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">
            We hit a snag with your number
          </h1>
        </header>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{friendly}</p>
        </div>
        <NumberPicker apiFetch={apiFetch} onClaimed={() => onRetryComplete?.()} />
        <div className="border-t border-slate-200 pt-4">
          {retryError && <p className="mb-2 text-sm text-red-600">{retryError}</p>}
          <Button
            variant="outline"
            size="lg"
            className="min-h-11"
            loading={retrying}
            onClick={() => void retry()}
          >
            {retrying ? 'Trying…' : 'Or let us pick a number for you'}
          </Button>
        </div>
      </div>
    );
  }

  // ── Provisioning in progress (no number yet) ───────────────────────
  if (!phoneNumber) {
    return (
      <div className="space-y-5 max-w-md">
        <header>
          <h1 className="text-2xl font-medium tracking-tight text-slate-900">
            Claiming your phone number
          </h1>
          <p className="text-sm text-slate-500 mt-2">
            We&apos;re reserving a local number you&apos;ll forward calls to.
          </p>
        </header>
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="size-2 rounded-full bg-slate-900 animate-pulse" />
          <p className="text-sm text-slate-700">
            {waitedLong
              ? "Still working — most numbers arrive in 30 seconds, occasionally up to a minute."
              : 'Usually takes about 30 seconds. This page refreshes automatically.'}
          </p>
        </div>
        <div className="border-t border-slate-200 pt-4">
          <p className="mb-3 text-xs text-slate-500">Prefer to choose your own number?</p>
          <NumberPicker apiFetch={apiFetch} onClaimed={() => onRetryComplete?.()} />
        </div>
      </div>
    );
  }

  // ── Ready (number provisioned) ─────────────────────────────────────
  return (
    <div className="space-y-7 max-w-xl">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-slate-900">
          Your business number is ready
        </h1>
        <p className="text-sm text-slate-500 mt-2">
          This is the number Rivet will answer in. Forward your existing line to it
          (instructions below) or share it directly with new customers.
        </p>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-center gap-2 text-slate-500">
          <Phone size={14} />
          <span className="text-xs uppercase tracking-widest">Your Rivet number</span>
        </div>
        <div className="mt-3 text-center text-3xl font-medium tracking-tight text-slate-900">
          {formatted || phoneNumber}
        </div>
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
      </div>

      <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
        <h2 className="text-sm font-medium text-slate-900">How to forward your business line</h2>
        <p className="mt-1 text-xs text-slate-600">
          From your existing business phone, dial the carrier code and then your new
          Rivet number. Forwarding turns on right away.
        </p>
        <ul className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {CARRIERS.map((c) => (
            <li key={c.name} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm font-medium text-slate-700">{c.name}</span>
              <span className="font-mono text-sm text-slate-600">
                {c.formatCode(national)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">
          To turn forwarding off later, dial <span className="font-mono">*73</span> (Verizon/AT&amp;T)
          or <span className="font-mono">##21#</span> (T-Mobile) from the same line.
        </p>
      </section>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <strong className="font-medium">Heads up:</strong> the AI doesn&apos;t start answering until you
        finish billing and turn it on. You can forward your line now or after — your call.
      </div>

      <div className="flex">
        <Button variant="primary" size="lg" onClick={onAdvance}>
          Continue to billing
        </Button>
      </div>
    </div>
  );
}
