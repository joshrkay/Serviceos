import { useCallback, useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { useApiClient } from '../../lib/apiClient';
import { Button } from '../ui';
import { NumberPicker, formatPhone } from '../phone/NumberPicker';
import { TextingRegistrationPanel } from './phone/TextingRegistrationPanel';

/**
 * #1563 — Settings → Phone. Shows the business number and its provisioning
 * state from GET /api/onboarding/phone (onboarding/phone-line.ts), reuses the
 * onboarding NumberPicker, and supports "change number" (owner-only and
 * billing-gated server-side: buy new → attach → repoint → release old; a
 * failed change keeps the current number and says so).
 *
 * Mobile: single column, no fixed widths, every control ≥44px (min-h-11).
 */

type LineState =
  | 'not_started'
  | 'setting_up'
  | 'awaiting_pick'
  | 'claiming'
  | 'active'
  | 'failed'
  | 'unavailable';

interface PhoneLine {
  state: LineState;
  phoneNumber: string | null;
  pendingNumber: string | null;
  changingTo: string | null;
  changeError: string | null;
  lastError: string | null;
}

const STATE_LABEL: Record<LineState, string> = {
  not_started: 'Not set up',
  setting_up: 'Setting up',
  awaiting_pick: 'Pick a number',
  claiming: 'Claiming',
  active: 'Active',
  failed: 'Needs attention',
  unavailable: 'Unavailable',
};

const POLL_MS = 5000;

export function PhoneSettingsPage() {
  const apiFetch = useApiClient();
  const [line, setLine] = useState<PhoneLine | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [autoPicking, setAutoPicking] = useState(false);
  const [autoPickError, setAutoPickError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/onboarding/phone');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setLoadError(body.message ?? `Couldn't load your phone number (HTTP ${res.status})`);
        return;
      }
      setLine((await res.json()) as PhoneLine);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load your phone number.");
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the page honest while a pick / change runs in the worker.
  const inFlight =
    !!line && (line.state === 'claiming' || line.state === 'setting_up' || !!line.changingTo);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function pickForMe() {
    setAutoPicking(true);
    setAutoPickError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/retry', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setAutoPickError(body.message ?? `Couldn't pick a number (HTTP ${res.status})`);
        return;
      }
      await load();
    } catch (err) {
      setAutoPickError(err instanceof Error ? err.message : 'Check your connection and try again.');
    } finally {
      setAutoPicking(false);
    }
  }

  if (loadError && !line) {
    return (
      <p role="alert" className="p-4 text-sm text-red-700">
        {loadError}
      </p>
    );
  }
  if (!line) {
    return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  }

  const canPick = line.state === 'awaiting_pick' || line.state === 'failed';

  return (
    <section
      data-testid="phone-settings"
      aria-label="Business phone number"
      className="mx-auto w-full max-w-2xl min-w-0 space-y-5 p-4"
    >
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Business phone number</h1>
        <p className="text-sm text-slate-600">
          The local number Rivet answers and texts from. Customers call this number (or your
          forwarded line).
        </p>
      </header>

      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-slate-500">
            <Phone size={14} />
            <span className="text-xs uppercase tracking-widest">Your Rivet number</span>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {STATE_LABEL[line.state]}
          </span>
        </div>
        <p className="mt-3 break-words text-2xl font-medium tracking-tight text-slate-900">
          {line.phoneNumber ? formatPhone(line.phoneNumber) : 'No number yet'}
        </p>
        {line.state === 'claiming' && (
          <p className="mt-2 text-sm text-slate-600">
            {line.pendingNumber
              ? `Claiming ${formatPhone(line.pendingNumber)}…`
              : 'Picking a number for you…'}
          </p>
        )}
        {line.changingTo && (
          <p className="mt-2 text-sm text-slate-600">
            Switching to {formatPhone(line.changingTo)}… your current number keeps working until
            the new one is ready.
          </p>
        )}
        {line.changeError && (
          <p role="status" className="mt-2 text-sm text-amber-800">
            {line.changeError}
          </p>
        )}
        {line.state === 'failed' && line.lastError && (
          <p role="status" className="mt-2 text-sm text-red-700">
            {line.lastError}
          </p>
        )}
      </div>

      {canPick && (
        <div className="space-y-4">
          <NumberPicker apiFetch={apiFetch} onClaimed={() => void load()} title="Pick your number" />
          <div>
            {autoPickError && <p className="mb-2 text-sm text-red-600">{autoPickError}</p>}
            <Button
              variant="outline"
              size="lg"
              className="min-h-11"
              loading={autoPicking}
              onClick={() => void pickForMe()}
            >
              {autoPicking ? 'Picking…' : 'Pick one for me'}
            </Button>
          </div>
        </div>
      )}

      {line.state === 'active' && !line.changingTo && (
        changing ? (
          <div className="space-y-3">
            <NumberPicker
              apiFetch={apiFetch}
              mode="change"
              title="Choose your new number"
              onClaimed={() => {
                setChanging(false);
                void load();
              }}
            />
            <p className="text-xs text-slate-500">
              We buy the new number first and only release the old one once the new one is live.
              Remember to update call forwarding to the new number.
            </p>
            <Button variant="ghost" size="lg" className="min-h-11" onClick={() => setChanging(false)}>
              Keep my current number
            </Button>
          </div>
        ) : (
          <Button variant="secondary" size="lg" className="min-h-11" onClick={() => setChanging(true)}>
            Change number
          </Button>
        )
      )}

      {/* #1564 — US A2P 10DLC texting registration (Rivet as ISV, no fee). */}
      <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
        <TextingRegistrationPanel />
      </div>
    </section>
  );
}
