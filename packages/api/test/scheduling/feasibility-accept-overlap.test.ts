import { describe, it, expect } from 'vitest';
import { withAcceptedOverlap } from '../../src/scheduling/feasibility';
import type { FeasibilityResult, FeasibilityIssue } from '../../src/scheduling/feasibility-types';

/**
 * Dispatch FR-2 phase 3c — a dispatcher may knowingly book a tech over a
 * visit already on their calendar ("Allow overlap if select by user"). Only
 * the `overlap` blockers are downgraded, and only when the flag is set;
 * skills, hours and time off still block.
 */
const overlap: FeasibilityIssue = {
  check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment x', conflictingEntityId: 'x',
};
const skill: FeasibilityIssue = { check: 'skill_match', severity: 'blocking', message: 'missing skill' };
const travel: FeasibilityIssue = { check: 'travel_time', severity: 'warning', message: 'tight drive' };

function result(blocking: FeasibilityIssue[], warnings: FeasibilityIssue[] = []): FeasibilityResult {
  return {
    feasible: blocking.length === 0, blocking, warnings, info: [],
    travelTime: { fromPrevSeconds: null, prevEndsAt: null, toNextSeconds: null, estimateSource: 'unknown', degraded: false },
    skillConstraints: 'none_configured',
  };
}

describe('withAcceptedOverlap', () => {
  it('leaves the result untouched when the overlap was not accepted', () => {
    const r = result([overlap]);
    expect(withAcceptedOverlap(r, false)).toBe(r);
  });

  it('turns accepted overlaps into warnings and makes the result feasible', () => {
    const out = withAcceptedOverlap(result([overlap], [travel]), true);
    expect(out.feasible).toBe(true);
    expect(out.blocking).toEqual([]);
    // The clash is still reported (first, so the approver sees it), as a warning.
    expect(out.warnings).toEqual([{ ...overlap, severity: 'warning' }, travel]);
  });

  it('still blocks on anything that is not an overlap', () => {
    const out = withAcceptedOverlap(result([overlap, skill]), true);
    expect(out.feasible).toBe(false);
    expect(out.blocking).toEqual([skill]);
    expect(out.warnings).toEqual([{ ...overlap, severity: 'warning' }]);
  });

  it('is a no-op when there is no overlap to accept', () => {
    const r = result([skill]);
    expect(withAcceptedOverlap(r, true)).toBe(r);
  });
});
