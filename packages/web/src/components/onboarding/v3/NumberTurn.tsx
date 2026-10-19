import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useState } from 'react';
import { useRivetLine } from '../../../hooks/useRivetVoice';
import { useApiClient } from '../../../lib/apiClient';
import { formatPhone } from '../../phone/NumberPicker';
import { Button, Input } from '../../ui';
import type { OnboardingStep } from '../../../types/onboarding';
import { CONNECTION_ERROR } from './connection-copy';
import { TAKEN_OFFER, emptyAreaCodeLine, failureAction, numberSearchErrorCopy, numberView, phoneRetryErrorCopy } from './phone-copy';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { NUMBER_WAIT } from './wait-copy';
import { WaitScreen } from './WaitScreen';

export interface NumberTurnProps {
  /** The phone step from the onboarding status; undefined before the first status. */
  step: OnboardingStep | undefined;
  /** Something changed on the server (a number was asked for): check the status again. May be async, so the waiting screen can show it is checking. */
  onChanged: () => void | Promise<void>;
}

/** A number POST /api/onboarding/phone/available offers (the shape components/phone/NumberPicker.tsx reads). */
interface Candidate {
  phoneNumber: string;
  locality?: string;
  region?: string;
}

/**
 * What the owner is doing with an area code, on top of what the status says:
 *   idle       nothing; the status decides the screen;
 *   area_code  typing an area code (`empty`: the last search there found nothing new);
 *   searching  looking in an area code;
 *   offer      one number shown, waiting for "That works" (`taken`: the last one went);
 *   claimed    "That works" went through: the number is being bought, and the
 *              next failure the status reports is about this number.
 */
type Pick =
  | { kind: 'idle' }
  | { kind: 'area_code'; empty: string | null }
  | { kind: 'searching'; areaCode: string }
  | { kind: 'offer'; areaCode: string; candidate: Candidate; taken: boolean }
  | { kind: 'claimed'; areaCode: string; phoneNumber: string };

const PRIMARY = 'h-14 whitespace-normal rounded-2xl text-[17px] font-semibold';
const SECONDARY = 'mt-2.5 h-14 whitespace-normal rounded-2xl text-[17px] font-semibold';
const AREA_CODE = /^\d{3}$/;
const NUMBER_READY = "Here's your number.";
const NUMBER_FAILED = "I couldn't get your number yet.";
const NUMBER_ASK = "Let's get your number.";

/**
 * The owner's number. The trial pays for it, so it is asked for only now. Rivet
 * waits for it, asks for it when none is held yet, says plainly when it could not
 * get one, and shows it as soon as it is known. When the number is done the shell
 * moves on by itself.
 *
 * What a failure offers comes from the status's failure code alone. Only a taken
 * number looks again: in the area code this turn itself searched, once per
 * number the owner took, and the next number waits for the owner's "That works"
 * (nothing is bought without it), so the turn never loops by itself. With no area
 * code held (a number picked for the owner, or a reload) it asks for one instead
 * of guessing. A problem on our side offers nothing to tap; any other failure
 * offers one Try again, sent only when the owner taps it.
 */
export function NumberTurn({ step, onChanged }: NumberTurnProps) {
  const apiFetch = useApiClient();
  const view = numberView(step);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick>({ kind: 'idle' });
  const [areaCode, setAreaCode] = useState('');
  const [pickError, setPickError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  // Every number the owner took this visit: a new search never offers one of them again.
  const tried = useRef<Set<string>>(new Set());
  // Rivet says the heading the owner is looking at; the wait for a number is not a line of its own.
  useRivetLine('number', view.kind === 'getting' ? null : view.kind === 'ready' ? NUMBER_READY : view.kind === 'error' ? NUMBER_FAILED : NUMBER_ASK);

  /** "Get my number" and "Try again" are the same request: the API picks a local number near the business. */
  const askForNumber = async () => {
    if (asking) return;
    setAsking(true);
    setAskError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/retry', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setAskError(phoneRetryErrorCopy(res.status, body.error));
        return;
      }
      void onChanged();
    } catch {
      setAskError(CONNECTION_ERROR);
    } finally {
      setAsking(false);
    }
  };

  /** Look in one area code and offer the first number the owner has not already taken. Nothing is bought here. */
  const search = async (code: string, taken: boolean) => {
    setPick({ kind: 'searching', areaCode: code });
    setPickError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/available', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ areaCode: code }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPick({ kind: 'area_code', empty: null });
        setPickError(numberSearchErrorCopy(res.status, body.error));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { numbers?: Candidate[] };
      const next = (body.numbers ?? []).find((n) => typeof n.phoneNumber === 'string' && !tried.current.has(n.phoneNumber));
      setPick(next ? { kind: 'offer', areaCode: code, candidate: next, taken } : { kind: 'area_code', empty: code });
    } catch {
      setPick({ kind: 'area_code', empty: null });
      setPickError(CONNECTION_ERROR);
    }
  };

  const searchTyped = (event: FormEvent) => {
    event.preventDefault();
    if (!AREA_CODE.test(areaCode)) {
      setPickError(numberSearchErrorCopy(400, 'INVALID_AREA_CODE'));
      return;
    }
    void search(areaCode, false);
  };

  /** "That works": buy exactly the number shown. The worker does the buying; the status says how it went. */
  const claim = async () => {
    if (pick.kind !== 'offer' || claiming) return;
    const { areaCode: code, candidate } = pick;
    setClaiming(true);
    setPickError(null);
    try {
      const res = await apiFetch('/api/onboarding/phone/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneNumber: candidate.phoneNumber }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPickError(phoneRetryErrorCopy(res.status, body.error));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { skipped?: boolean };
      tried.current.add(candidate.phoneNumber);
      // Already active: nothing is in flight, so there is nothing to look again for.
      setPick(body.skipped ? { kind: 'idle' } : { kind: 'claimed', areaCode: code, phoneNumber: candidate.phoneNumber });
      void onChanged();
    } catch {
      setPickError(CONNECTION_ERROR);
    } finally {
      setClaiming(false);
    }
  };

  const openAreaCode = () => {
    setPickError(null);
    setPick({ kind: 'area_code', empty: null });
  };

  // The first status after the owner's claim that says the step failed is about that number. Each status is a
  // new object, so this runs once per poll; it acts only while a claim is in flight, and ends it either way.
  useEffect(() => {
    if (pick.kind !== 'claimed' || view.kind !== 'error') return;
    if (failureAction(view.code) === 'area_code') void search(pick.areaCode, true);
    else setPick({ kind: 'idle' });
    // Only a new status can say how the claim went.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  if (view.kind === 'ready') {
    return (
      <>
        <SpeakerLine />
        <RivetHeading>Here&apos;s your number.</RivetHeading>
        <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">I&apos;m finishing the last details, then you can call it.</p>
        <div className="mt-5 rounded-2xl border border-border bg-card p-4 text-center">
          <p className="text-sm text-muted-foreground">Your number</p>
          <p className="mt-1 break-words font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
            {formatPhone(view.phoneNumber)}
          </p>
        </div>
      </>
    );
  }

  if (view.kind === 'getting' || pick.kind === 'claimed') {
    const pending = view.kind === 'getting' ? view.pendingNumber : pick.kind === 'claimed' ? pick.phoneNumber : null;
    return (
      <WaitScreen
        heading="Getting your number."
        support={pending ? `Claiming ${formatPhone(pending)}.` : 'A local number usually takes about 30 seconds.'}
        thresholds={NUMBER_WAIT}
        onRetry={onChanged}
        retryLabel="Check again"
      />
    );
  }

  if (pick.kind === 'searching') {
    return (
      <div role="status" aria-live="polite">
        <SpeakerLine />
        <RivetHeading>Looking for a number.</RivetHeading>
        <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">Checking what&apos;s free in {pick.areaCode}.</p>
      </div>
    );
  }

  if (pick.kind === 'offer') {
    const place = [pick.candidate.locality, pick.candidate.region].filter(Boolean).join(', ');
    return (
      <>
        <SpeakerLine />
        <RivetHeading>{NUMBER_READY}</RivetHeading>
        <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">I&apos;m finishing the last details, then you can call it.</p>
        <div className="mt-5 rounded-2xl border border-border bg-card p-4 text-center">
          <p className="break-words font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]">
            {formatPhone(pick.candidate.phoneNumber)}
          </p>
          {place ? <p className="mt-1 break-words text-sm text-muted-foreground">{place}</p> : null}
        </div>

        <div className="min-h-6 flex-1" />

        <div className="flex flex-col">
          {pickError ? (
            <p role="alert" className="mb-2.5 text-center text-sm text-destructive">
              {pickError}
            </p>
          ) : null}
          <Button fullWidth size="lg" className={PRIMARY} loading={claiming} onClick={() => void claim()}>
            That works
          </Button>
          <Button fullWidth variant="outline" size="lg" className={SECONDARY} disabled={claiming} onClick={openAreaCode}>
            Pick a different area code
          </Button>
        </div>
      </>
    );
  }

  const failed = view.kind === 'error';
  const action = failed ? failureAction(view.code) : null;

  if (pick.kind === 'area_code' || action === 'area_code') {
    const empty = pick.kind === 'area_code' ? pick.empty : null;
    const line = empty
      ? emptyAreaCodeLine(empty)
      : failed
        ? view.message
        : "Tell me the area code you want, and I'll show you a free number there first.";
    return (
      <>
        <SpeakerLine />
        <RivetHeading>Pick a different area code.</RivetHeading>
        <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{line}</p>
        <form className="mt-5 flex flex-col" onSubmit={searchTyped} noValidate>
          <label htmlFor="number-area-code" className="mb-1.5 text-sm font-medium text-foreground">
            Area code
          </label>
          <Input
            id="number-area-code"
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
            inputMode="numeric"
            autoComplete="off"
            placeholder="216"
            className="min-h-11 w-full text-base"
          />
          {pickError ? (
            <p role="alert" className="mt-2.5 text-center text-sm text-destructive">
              {pickError}
            </p>
          ) : null}
          <Button type="submit" fullWidth size="lg" className={`mt-4 ${PRIMARY}`}>
            Look for a number
          </Button>
        </form>
        {!failed ? (
          // Opened from "Let's get your number": the owner can still let Rivet pick one near the business.
          <Button fullWidth variant="outline" size="lg" className={SECONDARY} onClick={() => setPick({ kind: 'idle' })}>
            Pick one near my business
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <SpeakerLine />
      <RivetHeading>{failed ? NUMBER_FAILED : NUMBER_ASK}</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {failed ? view.message : "I'll pick a local one near your business."}
      </p>

      <div className="min-h-6 flex-1" />

      {action === 'none' ? null : (
        <div className="flex flex-col">
          {askError ? (
            <p role="alert" className="mb-2.5 text-center text-sm text-destructive">
              {askError}
            </p>
          ) : null}
          <Button fullWidth size="lg" className={PRIMARY} loading={asking} onClick={() => void askForNumber()}>
            {failed ? 'Try again' : 'Get my number'}
          </Button>
          {!failed ? (
            <Button fullWidth variant="outline" size="lg" className={SECONDARY} disabled={asking} onClick={openAreaCode}>
              Pick a different area code
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}
