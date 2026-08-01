/**
 * WS15 — in-process sweep heartbeat registry (the sweep-lag SLO's data source).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSweepSuccess,
  sweepLastSuccessMs,
  resetSweepHeartbeats,
} from '../../src/monitoring/sweep-heartbeats';

describe('sweep-heartbeats', () => {
  beforeEach(() => {
    resetSweepHeartbeats();
  });

  it('returns undefined for a sweep that never succeeded (fresh boot)', () => {
    expect(sweepLastSuccessMs('590023')).toBeUndefined();
  });

  it('records and reads back the last success per sweep name', () => {
    recordSweepSuccess('590023', 1000);
    recordSweepSuccess('590009', 2000);
    expect(sweepLastSuccessMs('590023')).toBe(1000);
    expect(sweepLastSuccessMs('590009')).toBe(2000);
  });

  it('a later success overwrites the earlier one', () => {
    recordSweepSuccess('590023', 1000);
    recordSweepSuccess('590023', 5000);
    expect(sweepLastSuccessMs('590023')).toBe(5000);
  });

  it('defaults the timestamp to now', () => {
    const before = Date.now();
    recordSweepSuccess('590023');
    const value = sweepLastSuccessMs('590023')!;
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});
