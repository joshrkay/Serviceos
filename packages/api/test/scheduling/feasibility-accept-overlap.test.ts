import { describe, it, expect } from 'vitest';
import { withAcceptedOverlap, overlappingAppointmentIds } from '../../src/scheduling/feasibility';
import type { FeasibilityResult, FeasibilityIssue } from '../../src/scheduling/feasibility-types';

/**
 * Dispatch FR-2 phase 3c — a dispatcher may knowingly book a tech over a
 * visit already on their calendar ("Allow overlap if select by user").
 * Consent is bound to the visits they reviewed: only `overlap` blockers
 * naming an accepted appointment are downgraded; a clash with any other
 * visit, and skills, hours and time off, still block.
 */
const overlapX: FeasibilityIssue = {
  check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment x', conflictingEntityId: 'x',
};
const overlapY: FeasibilityIssue = {
  check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment y', conflictingEntityId: 'y',
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
  it('leaves the result untouched when nothing was accepted', () => {
    const r = result([overlapX]);
    expect(withAcceptedOverlap(r, new Set())).toBe(r);
  });

  it('turns the accepted overlap into a warning and makes the result feasible', () => {
    const out = withAcceptedOverlap(result([overlapX], [travel]), new Set(['x']));
    expect(out.feasible).toBe(true);
    expect(out.blocking).toEqual([]);
    // The clash is still reported (first, so the approver sees it), as a warning.
    expect(out.warnings).toEqual([{ ...overlapX, severity: 'warning' }, travel]);
  });

  it('keeps blocking on an overlap the dispatcher never saw', () => {
    const out = withAcceptedOverlap(result([overlapX, overlapY]), new Set(['x']));
    expect(out.feasible).toBe(false);
    expect(out.blocking).toEqual([overlapY]);
    expect(out.warnings).toEqual([{ ...overlapX, severity: 'warning' }]);
  });

  it('still blocks on anything that is not an overlap', () => {
    const out = withAcceptedOverlap(result([overlapX, skill]), new Set(['x']));
    expect(out.feasible).toBe(false);
    expect(out.blocking).toEqual([skill]);
  });

  it('is a no-op when the accepted ids match no overlap', () => {
    const r = result([skill, overlapY]);
    expect(withAcceptedOverlap(r, new Set(['x']))).toBe(r);
  });

  it('overlappingAppointmentIds lists the overlap blockers\' appointments only', () => {
    expect(overlappingAppointmentIds(result([overlapX, skill, overlapY], [travel]))).toEqual(['x', 'y']);
    expect(overlappingAppointmentIds(result([skill]))).toEqual([]);
  });
});
