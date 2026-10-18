import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useApiClient } from '../../../lib/apiClient';
import { track, trackFunnel } from '../../../lib/analytics';
import { formatPhone } from '../../phone/NumberPicker';
import { Button } from '../../ui';
import { CONNECTION_ERROR } from './connection-copy';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { testCallScenario } from './test-call-scenario';

export interface TestCallTurnProps {
  /** The business number, from the phone step. */
  phoneNumber: string | null;
  /** The owner's pack, which picks the scenario Rivet asks them to act out. */
  packId?: string | null;
  /**
   * How the call step ended during this visit: the call was heard, or the owner chose to test later. Either way
   * the owner makes the one call that opens the phones. Null: still waiting for the call.
   */
  closing: Closing | null;
  /** The phones are already open (the server opens them itself when a test call ends). */
  voiceAgentLive: boolean;
  tenantId: string | null;
  userId: string | null | undefined;
  /** "I'll test later" lives in the header; when it fails, the reason is shown here. */
  testLaterError: string | null;
  /** The owner opened for business: the shell hands off. */
  onOpened: () => void;
}

export type Closing = 'heard' | 'skipped';

/** After this long with no call, say so and what to do (the original test-call step waits as long). */
const WAITED_LONG_MS = 60_000;

const ACTION = 'h-14 whitespace-normal rounded-2xl text-[17px] font-semibold';

/** "Now you call me." Then, once the call is heard, "Ready to open for business?" */
export function TestCallTurn({ phoneNumber, packId, closing, voiceAgentLive, tenantId, userId, testLaterError, onOpened }: TestCallTurnProps) {
  return closing ? (
    <OpenForBusiness closing={closing} alreadyOpen={voiceAgentLive} onOpened={onOpened} />
  ) : (
    <CallMe phoneNumber={phoneNumber} packId={packId} tenantId={tenantId} userId={userId} testLaterError={testLaterError} />
  );
}

function CallMe({ phoneNumber, packId, tenantId, userId, testLaterError }: Pick<TestCallTurnProps, 'phoneNumber' | 'packId' | 'tenantId' | 'userId' | 'testLaterError'>) {
  const [copied, setCopied] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);
  const initiated = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaitedLong(true), WAITED_LONG_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The owner's intent to call (tapping the number or copying it), once per visit.
  const markInitiated = () => {
    if (initiated.current) return;
    initiated.current = true;
    trackFunnel('test_call_initiated', { tenantId, userId });
  };

  const copy = async () => {
    if (!phoneNumber) return;
    markInitiated();
    try {
      await navigator.clipboard.writeText(phoneNumber);
      setCopied(true);
    } catch {
      // Best effort: some browsers only copy on a secure page.
    }
  };

  return (
    <>
      <SpeakerLine />
      <RivetHeading>Now you call me.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{testCallScenario(packId)}</p>

      {phoneNumber ? (
        <div className="mt-5 flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
          <p className="text-center text-sm text-muted-foreground">Call this number</p>
          <a
            href={`tel:${phoneNumber.replace(/[^\d+]/g, '')}`}
            onClick={markInitiated}
            className="flex min-h-14 w-full items-center justify-center break-words rounded-xl text-center font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {formatPhone(phoneNumber)}
          </a>
          <Button
            fullWidth
            variant="outline"
            size="lg"
            leftIcon={copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy number'}
          </Button>
        </div>
      ) : null}

      <p role="status" className="mt-4 flex items-start gap-3 text-base leading-[1.45] text-secondary-foreground">
        <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" />
        {waitedLong ? "I haven't heard it yet. Try calling again, or tap I'll test later." : 'Waiting for your call.'}
      </p>

      <div className="min-h-6 flex-1" />

      {testLaterError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {testLaterError}
        </p>
      ) : null}
    </>
  );
}

function OpenForBusiness({ closing, alreadyOpen, onOpened }: Pick<TestCallTurnProps, 'onOpened'> & { closing: Closing; alreadyOpen: boolean }) {
  const apiFetch = useApiClient();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      const res = await apiFetch('/api/voice/go-live', { method: 'POST' });
      if (!res.ok) {
        setError(
          res.status === 402
            ? "Your trial isn't active yet. Give it a minute, then try again."
            : "I couldn't open for business just now. Try again.",
        );
        return;
      }
      track('voice_agent_turned_on');
      onOpened();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setOpening(false);
    }
  };

  const skipped = closing === 'skipped';
  return (
    <>
      <SpeakerLine />
      <RivetHeading>
        {alreadyOpen
          ? "I got your call. You're open for business."
          : skipped
            ? 'No problem. Ready to open for business anyway?'
            : 'I got your call. Ready to open for business?'}
      </RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {skipped
          ? "Until you open, I send every caller to voicemail. You can also open any time from Settings."
          : 'Every job I book lands for your OK: one tap to confirm, one tap to undo, and you can always hear the call.'}
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {alreadyOpen ? (
          <Button fullWidth size="lg" className={ACTION} onClick={onOpened}>
            Take me home
          </Button>
        ) : (
          <>
            <Button fullWidth size="lg" className={ACTION} loading={opening} onClick={() => void open()}>
              That&apos;s right. Open for business.
            </Button>
            {skipped ? (
              <Button fullWidth variant="outline" size="lg" className={ACTION} disabled={opening} onClick={onOpened}>
                Not yet
              </Button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
