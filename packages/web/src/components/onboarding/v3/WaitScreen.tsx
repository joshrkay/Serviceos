import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';
import { DEFAULT_WAIT, WAIT_LINE, waitStage, type WaitStage, type WaitThresholds } from './wait-copy';

/** How long this screen has been up, as the stage Rivet speaks to. Restarts when the screen is replaced. */
function useWaitStage(thresholds: WaitThresholds = DEFAULT_WAIT): WaitStage {
  const [elapsedMs, setElapsedMs] = useState(0);
  const { stillWithYouMs, takingLongerMs } = thresholds;
  useEffect(() => {
    const timers = [stillWithYouMs, takingLongerMs].map((ms) => setTimeout(() => setElapsedMs(ms), ms));
    return () => timers.forEach(clearTimeout);
  }, [stillWithYouMs, takingLongerMs]);
  return waitStage(elapsedMs, { stillWithYouMs, takingLongerMs });
}

export interface WaitScreenProps {
  /** What Rivet is saying: under twenty words. */
  heading: string;
  /** The one supporting sentence. */
  support?: ReactNode;
  thresholds?: WaitThresholds;
  /** Offered once it is clearly slow. Absent: there is nothing to try again, so no button. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Owner-facing, one line: why the retry did not work. */
  retryError?: string | null;
  /** Once it is clearly slow: what Rivet adds about the waiting (e.g. that the choices may not have saved). */
  slowNote?: string;
  /** Once it is clearly slow: a way out other than waiting (a button), under the retry. */
  slowAction?: ReactNode;
  /** More controls under the retry (a way out). */
  children?: ReactNode;
}

/**
 * A turn that waits on the server. Quiet at first; "Still with you." after four
 * seconds; "This is taking longer than usual." and a Try again once it is slow.
 */
export function WaitScreen({ heading, support, thresholds, onRetry, retrying = false, retryError, slowNote, slowAction, children }: WaitScreenProps) {
  const stage = useWaitStage(thresholds);
  return (
    <>
      <SpeakerLine />
      <RivetHeading>{heading}</RivetHeading>
      {support ? <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{support}</p> : null}
      <p role="status" className="mt-3 min-h-6 text-base leading-[1.45] text-secondary-foreground">
        {WAIT_LINE[stage]}
      </p>
      {stage === 'taking_longer' && slowNote ? (
        <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">{slowNote}</p>
      ) : null}

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {retryError ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {retryError}
          </p>
        ) : null}
        {stage === 'taking_longer' && onRetry ? (
          <Button fullWidth size="lg" className="h-14 rounded-2xl text-[17px] font-semibold" loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {stage === 'taking_longer' ? slowAction : null}
        {children}
      </div>
    </>
  );
}
