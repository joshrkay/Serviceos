import { useState } from 'react';
import type { useApiClient } from '../../lib/apiClient';
import { Button, Input, cn } from '../ui';

/** Render +15125551234 → (512) 555-1234 for US numbers. */
export function formatPhone(e164: string | null | undefined): string {
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

interface NumberCandidate {
  phoneNumber: string;
  locality?: string;
  region?: string;
}

/**
 * Number picker: search Twilio by area code and claim a specific local
 * number. The (costly) purchase happens server-side in the provisioning
 * worker — this only lists candidates and submits the chosen E.164.
 * `onClaimed` refreshes status so the parent re-renders into the
 * "claiming…/ready" states once the worker runs.
 *
 * #1563 — shared by the onboarding Phone step (claim) and Settings → Phone
 * (change number): `mode` picks the endpoint and the button wording.
 */
export function NumberPicker({
  apiFetch,
  onClaimed,
  mode = 'claim',
  title = 'Pick your own number',
}: {
  apiFetch: ReturnType<typeof useApiClient>;
  onClaimed: () => void;
  mode?: 'claim' | 'change';
  title?: string;
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
    // Clear any prior result/claim error so a new search starts clean rather
    // than showing a stale "couldn't claim" message over fresh candidates.
    setClaimError(null);
    setCandidates([]);
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
      const res = await apiFetch(mode === 'change' ? '/api/onboarding/phone/change' : '/api/onboarding/phone/claim', {
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
        <h2 className="text-sm font-medium text-slate-900">{title}</h2>
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
            {selected
              ? `${mode === 'change' ? 'Switch to' : 'Claim'} ${formatPhone(selected)}`
              : 'Select a number'}
          </Button>
        </>
      )}
    </section>
  );
}
