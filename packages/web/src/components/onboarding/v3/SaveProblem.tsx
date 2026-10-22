import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Button } from '../../ui';
import { RivetHeading, SpeakerLine } from './TurnFrame';

const ACTION_CLASS = 'h-14 rounded-2xl text-[17px] font-semibold whitespace-normal';

/**
 * These screens replace the wait, and the wait's status line goes with it. Focus
 * moves onto the new heading so a screen-reader or keyboard owner is told.
 */
function useFocusOnMount() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return heading;
}

function StepByStep({ onSelect, primary }: { onSelect: () => void; primary: boolean }) {
  return (
    <Button fullWidth variant={primary ? 'primary' : 'outline'} size="lg" className={ACTION_CLASS} onClick={onSelect}>
      Go through setup step by step
    </Button>
  );
}

/** Shown on both screens: why the last tap did not work, or that another window got there first. */
function Lines({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {notice ? (
        <p role="status" className="text-center text-sm text-secondary-foreground">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function StartOver({ onSelect, busy, primary }: { onSelect: () => void; busy: boolean; primary: boolean }) {
  return (
    <Button fullWidth variant={primary ? 'primary' : 'outline'} size="lg" className={ACTION_CLASS} loading={busy} onClick={onSelect}>
      Start over
    </Button>
  );
}

export interface SaveProblemProps {
  /** Owner-facing, one line: why the last tap did not work. */
  error: string | null;
  /** One line: the setup changed in another window, so this screen was refreshed. */
  notice: string | null;
  /** Start over, when the set can still be returned to an editable draft (`recovery: 'reset'`); else absent. */
  onStartOver?: () => void;
  /** Start over is in flight: the button says so and a second tap sends nothing. */
  startingOver: boolean;
  onStepByStep: () => void;
}

export interface SaveFailedProps extends SaveProblemProps {
  /** Tapping Try again: the request is sent by the caller. */
  onRetry: () => void;
  /** The retry is in flight: the button says so and a second tap sends nothing. */
  retrying: boolean;
}

/**
 * A saved change did not go live. Said at once, not after the wait has gone on
 * long enough to look broken: the choices are still here, and trying again is
 * safe. Start over (back to the read-back, answers kept) is offered beside it
 * while nothing has gone through yet; going step by step is the last way out.
 */
export function SaveFailedScreen({ onRetry, retrying, error, notice, onStartOver, startingOver, onStepByStep }: SaveFailedProps) {
  const heading = useFocusOnMount();
  return (
    <>
      <SpeakerLine />
      <RivetHeading ref={heading}>Something didn&apos;t save.</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        Your answers are still here, and it&apos;s safe to try again.
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        <Lines error={error} notice={notice} />
        <Button fullWidth size="lg" className={ACTION_CLASS} loading={retrying} onClick={onRetry}>
          Try again
        </Button>
        {onStartOver ? <StartOver onSelect={onStartOver} busy={startingOver} primary={false} /> : null}
        <StepByStep onSelect={onStepByStep} primary={false} />
      </div>
    </>
  );
}

export interface SaveStoppedProps extends SaveProblemProps {
  /**
   * Part of the setup already went through (`recovery: 'settings'`): Settings is where it is finished, and
   * Start over is never offered. Absent with an API that predates the hint.
   */
  settings: boolean;
}

/**
 * The saved changes can no longer finish together (one was taken back or turned
 * down), so waiting or trying again cannot finish setup. While nothing has gone
 * through, Start over returns to the read-back with the answers kept. Once part
 * of it has, Settings is where the rest is finished. Going step by step stays as
 * the secondary way out.
 */
export function SaveStoppedScreen({ error, notice, onStartOver, startingOver, settings, onStepByStep }: SaveStoppedProps) {
  const heading = useFocusOnMount();
  return (
    <>
      <SpeakerLine />
      <RivetHeading ref={heading}>{settings ? 'Part of your setup already went through.' : 'Part of your setup was taken back.'}</RivetHeading>
      <p className="mt-3 text-base leading-[1.45] text-secondary-foreground">
        {settings
          ? "So I can't start over from here. You can finish the rest in Settings."
          : onStartOver
            ? 'Start over to set it up again. Your answers are still here.'
            : "I can't finish setup from here. You can go through it step by step instead."}
      </p>

      <div className="min-h-6 flex-1" />

      <div className="flex flex-col gap-2.5">
        <Lines error={error} notice={notice} />
        {settings ? (
          <Link
            to="/settings"
            className="inline-flex min-h-11 h-14 w-full items-center justify-center rounded-2xl bg-primary px-5 text-center text-[17px] font-semibold whitespace-normal text-primary-foreground hover:bg-primary/90"
          >
            Finish in Settings
          </Link>
        ) : null}
        {onStartOver ? <StartOver onSelect={onStartOver} busy={startingOver} primary /> : null}
        <StepByStep onSelect={onStepByStep} primary={!settings && !onStartOver} />
      </div>
    </>
  );
}
