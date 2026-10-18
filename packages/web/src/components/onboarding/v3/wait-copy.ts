/**
 * What Rivet says while a screen waits on the server (spec: the "Thinking"
 * state). Pure, so the thresholds the owner feels are pinned by a unit test.
 * Nothing extra for the first moments, "Still with you." once it passes four
 * seconds, and an honest "This is taking longer than usual." with a way to try
 * again once it is clearly slow.
 */

export interface WaitThresholds {
  stillWithYouMs: number;
  takingLongerMs: number;
}

export type WaitStage = 'waiting' | 'still_with_you' | 'taking_longer';

/** Saving the choices and starting the trial: a few seconds when all is well. */
export const DEFAULT_WAIT: WaitThresholds = { stillWithYouMs: 4_000, takingLongerMs: 20_000 };

/** A number can take up to half a minute to arrive, so it is not "slow" before that. */
export const NUMBER_WAIT: WaitThresholds = { stillWithYouMs: 4_000, takingLongerMs: 30_000 };

export function waitStage(elapsedMs: number, thresholds: WaitThresholds = DEFAULT_WAIT): WaitStage {
  if (!(elapsedMs > 0)) return 'waiting';
  if (elapsedMs >= thresholds.takingLongerMs) return 'taking_longer';
  if (elapsedMs >= thresholds.stillWithYouMs) return 'still_with_you';
  return 'waiting';
}

/** The line added under the support sentence at each stage. */
export const WAIT_LINE: Record<WaitStage, string | null> = {
  waiting: null,
  still_with_you: 'Still with you.',
  taking_longer: 'This is taking longer than usual.',
};
