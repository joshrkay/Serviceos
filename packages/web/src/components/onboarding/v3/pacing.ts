/**
 * Header timing for the choice turns. Pure, so the numbers the owner reads
 * ("About 5 minutes left", the progress line) are pinned by a unit test.
 */

/** Where the progress line sits on Ready, and where it ends up on the read-back. */
export const READY_PROGRESS = 0.15;
export const READBACK_PROGRESS = 0.5;

/** What still follows the choices once they are done: the read-back, billing, the number and the test call. */
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
