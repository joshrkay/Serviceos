/**
 * VQ2-012 — median-of-three helper tests.
 *
 * Pure function. Pins behavior used by the majority-vote aggregator for
 * caller-experience latency aggregation: median, not P95 across three
 * samples (P95-of-three is statistically meaningless per the plan
 * §"Voting strategy"). Defensive default for empty input is 0 — the
 * caller-experience aggregator only ever feeds three values, but the
 * helper is small enough to harden against zero-length input rather
 * than throw.
 */
import { describe, it, expect } from 'vitest';
import { median } from '../../../src/ai/voice-quality/voting/median-of-three';

describe('VQ2-012 — median-of-three', () => {
  it('VQ2-012 — median([1]) === 1', () => {
    expect(median([1])).toBe(1);
  });

  it('VQ2-012 — median([1,2,3]) === 2', () => {
    expect(median([1, 2, 3])).toBe(2);
  });

  it('VQ2-012 — median([3,1,2]) === 2 (sorts first)', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('VQ2-012 — median([]) === 0 (defensive default)', () => {
    expect(median([])).toBe(0);
  });

  it('VQ2-012 — median([100, 100, 300]) === 100 (duplicates allowed)', () => {
    expect(median([100, 100, 300])).toBe(100);
  });
});
