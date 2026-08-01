import { describe, it, expect } from 'vitest';
import { monthWindows, summarizeJobsBooked } from '../../src/analytics/jobs-booked';

describe('monthWindows', () => {
  it('computes UTC [start,end) windows for the month and the prior month', () => {
    const w = monthWindows('2026-06');
    expect(w.thisStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(w.thisEnd.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(w.priorStart.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('rolls the year back for January', () => {
    const w = monthWindows('2026-01');
    expect(w.thisStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.thisEnd.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(w.priorStart.toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });
});

describe('summarizeJobsBooked', () => {
  it('computes the trend and percentage vs the prior month', () => {
    const s = summarizeJobsBooked('2026-06', 12, 8);
    expect(s).toEqual({
      month: '2026-06',
      bookedThisPeriod: 12,
      bookedPriorPeriod: 8,
      trend: 4,
      trendPct: 50,
    });
  });

  it('reports a negative trend', () => {
    const s = summarizeJobsBooked('2026-06', 6, 10);
    expect(s.trend).toBe(-4);
    expect(s.trendPct).toBe(-40);
  });

  it('returns a null percentage when there is no prior-month baseline', () => {
    const s = summarizeJobsBooked('2026-06', 5, 0);
    expect(s.trend).toBe(5);
    expect(s.trendPct).toBeNull();
  });
});
