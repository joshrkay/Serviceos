import { describe, expect, it } from 'vitest';
import { AFTER_PACING, READBACK_PROGRESS, READY_PROGRESS, highestSeen, minutesLeft, turnProgress, type AfterStage } from './pacing';

describe('pacing', () => {
  it('estimates minutes from the work still ahead, never below one', () => {
    expect(minutesLeft(7)).toBe(6);
    expect(minutesLeft(6)).toBe(5);
    expect(minutesLeft(5)).toBe(5);
    expect(minutesLeft(4)).toBe(5);
    expect(minutesLeft(3)).toBe(4);
    expect(minutesLeft(2)).toBe(4);
    expect(minutesLeft(1)).toBe(3);
    expect(minutesLeft(0)).toBe(3);
    expect(minutesLeft(-20)).toBe(1);
  });

  it('only ever counts down as choices are answered', () => {
    const readings = [7, 6, 5, 4, 3, 2, 1, 0].map(minutesLeft);
    for (let i = 1; i < readings.length; i += 1) expect(readings[i]).toBeLessThanOrEqual(readings[i - 1]);
  });

  it('moves the progress line through the band between Ready and the read-back', () => {
    expect(READY_PROGRESS).toBe(0.15);
    expect(READBACK_PROGRESS).toBe(0.5);
    expect(turnProgress(0, 7)).toBeCloseTo(0.15, 10);
    expect(turnProgress(7, 7)).toBeCloseTo(0.5, 10);
    expect(turnProgress(3, 7)).toBeCloseTo(0.15 + (0.35 * 3) / 7, 10);
  });

  it('stays inside the band for out-of-range input', () => {
    expect(turnProgress(-2, 7)).toBeCloseTo(0.15, 10);
    expect(turnProgress(9, 7)).toBeCloseTo(0.5, 10);
    expect(turnProgress(0, 0)).toBeCloseTo(0.15, 10);
  });

  it('keeps the highest progress seen, so going back to edit never lowers it', () => {
    expect(highestSeen(0.5, 0.3)).toBe(0.5);
    expect(highestSeen(0.3, 0.5)).toBe(0.5);
    expect(highestSeen(0, 0.15)).toBe(0.15);
  });

  describe('after "That\'s right"', () => {
    const ORDER: AfterStage[] = ['saving', 'wait', 'trial', 'number', 'test_call', 'open'];

    it('reads the numbers the brief names for the trial, the number, the test call and open', () => {
      expect(AFTER_PACING.trial).toEqual({ minutesLeft: 3, progress: 0.7 });
      expect(AFTER_PACING.number).toEqual({ minutesLeft: 2, progress: 0.8 });
      expect(AFTER_PACING.test_call).toEqual({ minutesLeft: 1, progress: 0.9 });
      expect(AFTER_PACING.open.progress).toBe(1);
    });

    it('continues the read-back without a step back: minutes never rise, the line never falls', () => {
      let minutes = minutesLeft(0);
      let line = READBACK_PROGRESS;
      for (const stage of ORDER) {
        expect(AFTER_PACING[stage].minutesLeft, `${stage} minutes`).toBeLessThanOrEqual(minutes);
        expect(AFTER_PACING[stage].progress, `${stage} progress`).toBeGreaterThanOrEqual(line);
        minutes = AFTER_PACING[stage].minutesLeft;
        line = AFTER_PACING[stage].progress;
      }
    });

    it('never leaves less than a minute, and never goes past a full line', () => {
      for (const stage of ORDER) {
        expect(AFTER_PACING[stage].minutesLeft).toBeGreaterThanOrEqual(1);
        expect(AFTER_PACING[stage].progress).toBeLessThanOrEqual(1);
      }
    });
  });
});
