import type { ReactNode } from 'react';
import { cn } from '../../ui/utils';

export interface TurnFrameProps {
  minutesLeft: number;
  /** Right-hand header text: what is true about the owner's answers right now. */
  statusLabel?: string;
  /** 0 to 1. Only ever moves forward. */
  progress: number;
  children: ReactNode;
}

function minutesLeftLabel(minutes: number): string {
  return `About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;
}

/**
 * The one surface every turn renders into: a thin header, a 3px progress line,
 * then the turn. Phone-first at 390px; centred at 480px on a desktop. No
 * sidebar, no step list.
 */
export function TurnFrame({ minutesLeft, statusLabel, progress, children }: TurnFrameProps) {
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5 pb-7 pt-6 text-foreground">
      <header className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{minutesLeftLabel(minutesLeft)}</span>
          {statusLabel ? <span className="flex min-h-11 items-center text-right">{statusLabel}</span> : null}
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-[3px] rounded-full bg-border"
        >
          <div className="h-[3px] rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
      </header>
      {children}
    </main>
  );
}

/** Blue dot and "Rivet": who is speaking. */
export function SpeakerLine() {
  return (
    <div className="mt-7 flex items-center gap-2">
      <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-primary" />
      <span className="text-sm font-semibold text-primary">Rivet</span>
    </div>
  );
}

/** What Rivet is saying. Under twenty words, first person. */
export function RivetHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h1 className={cn('mt-2.5 break-words font-display text-[30px] font-semibold leading-[1.1] tracking-[-0.02em]', className)}>
      {children}
    </h1>
  );
}
