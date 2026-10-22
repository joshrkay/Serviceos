/**
 * Header timing for the choice turns. Pure, so the numbers the owner reads
 * ("About 5 minutes left", the progress line) are pinned by a unit test.
 */

/** Where the progress line sits on Ready, and where it ends up on the read-back. */
export const READY_PROGRESS = 0.15;
export const READBACK_PROGRESS = 0.5;

/** What still follows the choices once they are done: the read-back, the trial, the number and the test call. */
const REST_MINUTES = 3;
const MINUTES_PER_TURN = 0.4;

/** "About N minutes left" given how many choices are still to answer. Never below one. */
export function minutesLeft(remainingTurns: number): number {
  return Math.max(1, Math.round(remainingTurns * MINUTES_PER_TURN + REST_MINUTES));
}

/** The progress line while turns are answered: `answered` of `total`, mapped into the Ready-to-read-back band. */
export function turnProgress(answered: number, total: number): number {
  const share = total > 0 ? Math.min(1, Math.max(0, answered / total)) : 0;
  return READY_PROGRESS + share * (READBACK_PROGRESS - READY_PROGRESS);
}

/** The progress line only moves forward: going back to edit a choice never lowers it. */
export function highestSeen(seen: number, next: number): number {
  return Math.max(seen, next);
}

/** Where the owner is once "That's right" has been tapped. */
export type AfterStage = 'saving' | 'wait' | 'trial' | 'number' | 'test_call' | 'open';

export interface AfterPacing {
  minutesLeft: number;
  progress: number;
}

/**
 * The header and progress line after the read-back, continuing from
 * READBACK_PROGRESS (0.5): each stage is at or below the last in minutes and at
 * or above it in progress, and "open" is the full line.
 */
export const AFTER_PACING: Record<AfterStage, AfterPacing> = {
  saving: { minutesLeft: 3, progress: 0.6 },
  wait: { minutesLeft: 3, progress: 0.65 },
  trial: { minutesLeft: 3, progress: 0.7 },
  number: { minutesLeft: 2, progress: 0.8 },
  test_call: { minutesLeft: 1, progress: 0.9 },
  open: { minutesLeft: 1, progress: 1 },
};
