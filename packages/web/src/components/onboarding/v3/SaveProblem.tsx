import { Button } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';

const ACTION_CLASS = 'h-14 rounded-2xl text-[17px] font-semibold whitespace-normal';

function StepByStep({ onSelect, primary }: { onSelect: () => void; primary: boolean }) {
  return (
    <Button fullWidth variant={primary ? 'primary' : 'outline'} size="lg" className={ACTION_CLASS} onClick={onSelect}>
      Go through setup step by step
    </Button>
  );
}

export interface SaveFailedProps {
  /** Tapping Try again: the request is sent by the caller. */
  onRetry: () => void;
  /** The retry is in flight: the button says so and a second tap sends nothing. */
  retrying: boolean;
  /** Owner-facing, one line: why the last try did not work. */
  error: string | null;
  onStepByStep: () => void;
}

/**
 * A saved change did not go live. Said at once, not after the wait has gone on
 * long enough to look broken: the choices are still here, and trying again is
 * safe. Going step by step is the way out when trying again does not help.
 */
export function SaveFailedScreen({ onRetry, retrying, error, onStepByStep }: SaveFailedProps) {
  return (
    <>
      <SpeakerLine />
      <RivetHeading>Something didn&apos;t save.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        Your answers are still here, and it&apos;s safe to try again.
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button fullWidth size="lg" className={ACTION_CLASS} loading={retrying} onClick={onRetry}>
          Try again
        </Button>
        <StepByStep onSelect={onStepByStep} primary={false} />
      </div>
    </>
  );
}

/**
 * One of the two saved changes was undone or turned down, so waiting or trying
 * again cannot finish setup: the only way on is to go through it step by step.
 */
export function SaveStoppedScreen({ onStepByStep }: { onStepByStep: () => void }) {
  return (
    <>
      <SpeakerLine />
      <RivetHeading>One of your changes was undone.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        I can&apos;t finish setup from here. You can go through it step by step instead.
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        <StepByStep onSelect={onStepByStep} primary />
      </div>
    </>
  );
}
