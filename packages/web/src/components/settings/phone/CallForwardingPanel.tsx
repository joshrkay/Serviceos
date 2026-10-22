import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../../../lib/apiClient';
import {
  CALL_FORWARDING_CARRIERS,
  CALL_FORWARDING_CARRIER_LABELS,
  buildCallForwardingInstructions,
  type CallForwardingCarrier,
  type CallForwardingMode,
} from '@ai-service-os/shared';

/**
 * D-044 / #1765 — Settings → Phone → "Forward your calls". The owner keeps
 * their number and forwards it to their Rivet line: pick a carrier and a mode
 * (missed calls only, the default, or all calls) and see the code to dial, a
 * tap-to-dial link, and the code that turns forwarding off. Backed by
 * GET/PUT /api/get-found-online/forwarding (owner-only).
 *
 * Mobile: single column, every control >=44px (min-h-11), codes wrap.
 */

interface ForwardingState {
  carrier: CallForwardingCarrier | null;
  mode: CallForwardingMode;
  checkPassedAt: string | null;
  rivetNumber: string | null;
}

const MODE_LABEL: Record<CallForwardingMode, { title: string; hint: string }> = {
  missed: {
    title: 'Missed calls only',
    hint: 'Your phone rings first. Rivet answers when you do not pick up or are busy.',
  },
  all: {
    title: 'All calls',
    hint: 'Rivet answers every call. Your phone does not ring.',
  },
};

const CHOICE_BASE =
  'flex min-h-11 w-full items-center rounded-xl border px-4 py-2 text-left text-sm';

function choiceClass(selected: boolean): string {
  return `${CHOICE_BASE} ${
    selected
      ? 'border-slate-900 bg-slate-900 text-white'
      : 'border-slate-200 bg-white text-slate-800 hover:bg-slate-50'
  }`;
}

export function CallForwardingPanel() {
  const apiFetch = useApiClient();
  const [state, setState] = useState<ForwardingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/get-found-online/forwarding');
      if (!res.ok) {
        setLoadError("Couldn't load your call forwarding setup.");
        return;
      }
      setState(((await res.json()) as { data: ForwardingState }).data);
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load your call forwarding setup.");
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(carrier: CallForwardingCarrier, mode: CallForwardingMode) {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch('/api/get-found-online/forwarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrier, mode }),
      });
      if (!res.ok) {
        setSaveError("Couldn't save that. Try again.");
        return;
      }
      setState(((await res.json()) as { data: ForwardingState }).data);
    } catch {
      setSaveError('Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  if (loadError && !state) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {loadError}
      </p>
    );
  }
  if (!state) return <p className="text-sm text-slate-500">Loading…</p>;

  const mode = state.mode;
  const instructions = state.carrier
    ? buildCallForwardingInstructions({
        carrier: state.carrier,
        mode,
        rivetNumber: state.rivetNumber,
      })
    : null;

  return (
    <div data-testid="call-forwarding-panel" className="min-w-0 space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-slate-900">Forward your calls to Rivet</h2>
        <p className="text-sm text-slate-600">
          Keep the number your customers already call. Forward it to your Rivet number and the AI
          answers.
        </p>
      </div>

      <fieldset className="space-y-2" disabled={saving}>
        <legend className="mb-1 text-sm font-medium text-slate-800">Your carrier</legend>
        {CALL_FORWARDING_CARRIERS.map((carrier) => (
          <button
            key={carrier}
            type="button"
            aria-pressed={state.carrier === carrier}
            className={choiceClass(state.carrier === carrier)}
            onClick={() => void save(carrier, mode)}
          >
            {CALL_FORWARDING_CARRIER_LABELS[carrier]}
          </button>
        ))}
      </fieldset>

      <fieldset className="space-y-2" disabled={saving}>
        <legend className="mb-1 text-sm font-medium text-slate-800">Which calls</legend>
        {(Object.keys(MODE_LABEL) as CallForwardingMode[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            disabled={!state.carrier}
            className={`${choiceClass(mode === m)} flex-col items-start justify-center disabled:opacity-60`}
            onClick={() => state.carrier && void save(state.carrier, m)}
          >
            <span className="font-medium">{MODE_LABEL[m].title}</span>
            <span className={`text-xs ${mode === m ? 'text-slate-200' : 'text-slate-500'}`}>
              {MODE_LABEL[m].hint}
            </span>
          </button>
        ))}
      </fieldset>

      {saveError && (
        <p role="alert" className="text-sm text-red-700">
          {saveError}
        </p>
      )}

      {state.carrier && !instructions && (
        <p role="status" className="text-sm text-amber-800">
          Your Rivet number isn&apos;t ready yet. The code to dial appears once it is.
        </p>
      )}

      {instructions?.kind === 'codes' && (
        <div data-testid="call-forwarding-codes" className="min-w-0 space-y-3 rounded-xl bg-slate-50 p-4">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-widest text-slate-500">
              From your business phone, dial
            </p>
            <p className="break-all font-mono text-lg text-slate-900">{instructions.dial}</p>
            <a
              href={instructions.dialHref}
              className="inline-flex min-h-11 items-center rounded-lg bg-slate-900 px-4 text-sm font-medium text-white"
            >
              Tap to dial
            </a>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-widest text-slate-500">
              To turn forwarding off, dial
            </p>
            <p className="break-all font-mono text-base text-slate-900">{instructions.off}</p>
            <a
              href={instructions.offHref}
              className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-800"
            >
              Tap to dial
            </a>
          </div>
        </div>
      )}

      {instructions?.kind === 'generic' && (
        <div data-testid="call-forwarding-generic" className="space-y-2 rounded-xl bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-800">Call your carrier and ask them to:</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            {instructions.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {state.rivetNumber && (
            <p className="break-words text-sm text-slate-700">
              Your Rivet number is <span className="font-mono">{state.rivetNumber}</span>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
