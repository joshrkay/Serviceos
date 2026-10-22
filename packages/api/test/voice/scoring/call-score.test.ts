/**
 * #1736 — rubric arithmetic. Expected values are worked out from the declared
 * weights (booked 35, price 25, escalation 25, follow-up 15), not from the code.
 */
import { describe, it, expect } from 'vitest';
import { computeScore, needsReview, RUBRIC_WEIGHTS } from '../../../src/voice/scoring/call-score';

describe('computeScore (#1736)', () => {
  it('weights sum to 100', () => {
    expect(Object.values(RUBRIC_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('is 100 when every item passes and 0 when every item fails', () => {
    const ids = ['booked', 'price_grounded', 'escalation_handled', 'follow_up_set'] as const;
    expect(computeScore(ids.map((id) => ({ id, verdict: 'pass' as const })))).toBe(100);
    expect(computeScore(ids.map((id) => ({ id, verdict: 'fail' as const })))).toBe(0);
  });

  it('drops not_applicable items and renormalises: booked fail + follow-up pass = 15/50', () => {
    expect(
      computeScore([
        { id: 'booked', verdict: 'fail' },
        { id: 'follow_up_set', verdict: 'pass' },
        { id: 'price_grounded', verdict: 'not_applicable' },
        { id: 'escalation_handled', verdict: 'not_applicable' },
      ]),
    ).toBe(30);
  });

  it('rounds to an integer (35 of 60 = 58.33 -> 58)', () => {
    expect(
      computeScore([
        { id: 'booked', verdict: 'pass' },
        { id: 'price_grounded', verdict: 'fail' },
      ]),
    ).toBe(58);
  });

  it('returns null when nothing applies, and counts a duplicated id once', () => {
    expect(computeScore([{ id: 'booked', verdict: 'not_applicable' }])).toBeNull();
    expect(
      computeScore([
        { id: 'booked', verdict: 'pass' },
        { id: 'booked', verdict: 'fail' },
      ]),
    ).toBe(100);
  });
});

describe('needsReview (#1736)', () => {
  const flag = (kind: 'strength' | 'missed_opportunity') => ({ kind, turnIndex: 0, excerpt: '', note: '' });
  it('is true for a failed item or a non-strength flag, false for strengths only', () => {
    expect(needsReview({ items: [{ id: 'booked', verdict: 'fail', rationale: '' }], flags: [] })).toBe(true);
    expect(needsReview({ items: [], flags: [flag('missed_opportunity')] })).toBe(true);
    expect(needsReview({ items: [{ id: 'booked', verdict: 'pass', rationale: '' }], flags: [flag('strength')] })).toBe(false);
  });
});
