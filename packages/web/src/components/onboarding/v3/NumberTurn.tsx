import { useState } from 'react';
import { useRivetLine } from '../../../hooks/useRivetVoice';
import { useApiClient } from '../../../lib/apiClient';
import { formatPhone } from '../../phone/NumberPicker';
import { Button } from '../../ui';
import type { OnboardingStep } from '../../../types/onboarding';
import { CONNECTION_ERROR } from './connection-copy';
import { numberView, phoneRetryErrorCopy } from './phone-copy';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { NUMBER_WAIT } from './wait-copy';
import { WaitScreen } from './WaitScreen';

export interface NumberTurnProps {
  /** The phone step from the onboarding status; undefined before the first status. */
  step: OnboardingStep | undefined;
  /** Something changed on the server (a number was asked for): check the status again. May be async, so the waiting screen can show it is checking. */
  onChanged: () => void | Promise<void>;
}

const PRIMARY = 'h-14 whitespace-normal rounded-2xl text-[17px] font-semibold';
const NUMBER_READY = "Here's your number.";
const NUMBER_FAILED = "I couldn't get your number yet.";
const NUMBER_ASK = "Let's get your number.";

/**
 * The owner's number. The trial pays for it, so it is asked for only now. Rivet
 * waits for it, asks for it when none is held yet, says plainly when it could not
 * get one, and shows it as soon as it is known. When the number is done the shell
 * moves on by itself.
 */
export function NumberTurn({ step, onChanged }: NumberTurnProps) {
  const apiFetch = useApiClient();
  const view = numberView(step);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
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

  if (view.kind === 'getting') {
    return (
      <WaitScreen
        heading="Getting your number."
        support={view.pendingNumber ? `Claiming ${formatPhone(view.pendingNumber)}.` : 'A local number usually takes about 30 seconds.'}
        thresholds={NUMBER_WAIT}
        onRetry={onChanged}
        retryLabel="Check again"
      />
    );
  }

  if (view.kind === 'ready') {
    return (
      <>
        <SpeakerLine />
        <RivetHeading>{NUMBER_READY}</RivetHeading>
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

  const failed = view.kind === 'error';
  return (
    <>
      <SpeakerLine />
      <RivetHeading>{failed ? NUMBER_FAILED : NUMBER_ASK}</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {failed ? view.message : "I'll pick a local one near your business."}
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {askError ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {askError}
          </p>
        ) : null}
        <Button fullWidth size="lg" className={PRIMARY} loading={asking} onClick={() => void askForNumber()}>
          {failed ? 'Try again' : 'Get my number'}
        </Button>
        {/* S5 (U6) adds "Different area code" and "I have a number already" under this button. */}
      </div>
    </>
  );
}
