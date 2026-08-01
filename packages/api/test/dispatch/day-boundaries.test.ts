import { describe, it, expect } from 'vitest';
import { getDayBoundaries } from '../../src/dispatch/board-query';

describe('getDayBoundaries', () => {
  it('spans a full UTC day for the UTC timezone', () => {
    const { start, end } = getDayBoundaries('2026-05-28', 'UTC');
    expect(start.toISOString()).toBe('2026-05-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-28T23:59:59.999Z');
  });

  it('applies the tenant offset for a non-DST day (America/New_York, EDT)', () => {
    const { start, end } = getDayBoundaries('2026-05-28', 'America/New_York');
    // 00:00 EDT (UTC-4) = 04:00Z; 23:59:59.999 EDT = next day 03:59:59.999Z.
    expect(start.toISOString()).toBe('2026-05-28T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-29T03:59:59.999Z');
  });

  it('uses per-boundary offsets on the fall-back DST day (25h) — no dropped first hour', () => {
    // 2026-11-01 America/New_York: clocks fall back 02:00 EDT→01:00 EST.
    // Local midnight is still EDT (UTC-4) = 04:00Z; a noon offset (EST, UTC-5)
    // would wrongly start at 05:00Z and drop 00:00–00:59 local.
    const { start, end } = getDayBoundaries('2026-11-01', 'America/New_York');
    expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T04:59:59.999Z'); // 23:59:59.999 EST
    expect((end.getTime() - start.getTime()) / 3_600_000).toBeCloseTo(25, 5);
  });

  it('uses per-boundary offsets on the spring-forward DST day (23h)', () => {
    // 2026-03-08 America/New_York: clocks spring forward 02:00 EST→03:00 EDT.
    const { start, end } = getDayBoundaries('2026-03-08', 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z'); // 00:00 EST (UTC-5)
    expect(end.toISOString()).toBe('2026-03-09T03:59:59.999Z'); // 23:59:59.999 EDT (UTC-4)
    expect((end.getTime() - start.getTime()) / 3_600_000).toBeCloseTo(23, 5);
  });
});
