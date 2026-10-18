import { describe, expect, it } from 'vitest';
import { DEFAULT_WAIT, NUMBER_WAIT, WAIT_LINE, waitStage } from './wait-copy';

describe('wait copy', () => {
  it('says nothing extra for the first four seconds, then "Still with you.", then admits it is slow at twenty', () => {
    expect(waitStage(0)).toBe('waiting');
    expect(waitStage(3_999)).toBe('waiting');
    expect(waitStage(4_000)).toBe('still_with_you');
    expect(waitStage(19_999)).toBe('still_with_you');
    expect(waitStage(20_000)).toBe('taking_longer');
    expect(waitStage(10 * 60_000)).toBe('taking_longer');
  });

  it('uses the thresholds the spec names by default', () => {
    expect(DEFAULT_WAIT).toEqual({ stillWithYouMs: 4_000, takingLongerMs: 20_000 });
  });

  it('gives a number up to thirty seconds before calling it slow, because that is how long one takes', () => {
    expect(NUMBER_WAIT).toEqual({ stillWithYouMs: 4_000, takingLongerMs: 30_000 });
    expect(waitStage(29_999, NUMBER_WAIT)).toBe('still_with_you');
    expect(waitStage(30_000, NUMBER_WAIT)).toBe('taking_longer');
  });

  it('treats a clock that has not started, or went backwards, as the start', () => {
    expect(waitStage(-5)).toBe('waiting');
    expect(waitStage(Number.NaN)).toBe('waiting');
  });

  it('has the exact lines Rivet says, and nothing for the first stage', () => {
    expect(WAIT_LINE).toEqual({
      waiting: null,
      still_with_you: 'Still with you.',
      taking_longer: 'This is taking longer than usual.',
    });
  });
});
