import { describe, it, expect } from 'vitest';
import {
  addCalendarDays,
  isValidTimezone,
  tzMidnight,
} from '../../src/shared/timezone';

describe('P12-002 timezone helpers', () => {
  describe('tzMidnight', () => {
    it('returns 07:00Z for May 4 2026 in America/Los_Angeles (PDT, -7)', () => {
      // PDT is UTC-7 in May, so local midnight is 07:00 UTC.
      const got = tzMidnight('2026-05-04', 'America/Los_Angeles');
      expect(got.toISOString()).toBe('2026-05-04T07:00:00.000Z');
    });

    it('returns 05:00Z for Jan 5 2026 in America/New_York (EST, -5)', () => {
      const got = tzMidnight('2026-01-05', 'America/New_York');
      expect(got.toISOString()).toBe('2026-01-05T05:00:00.000Z');
    });

    it('returns UTC midnight when tz is "UTC"', () => {
      const got = tzMidnight('2026-05-04', 'UTC');
      expect(got.toISOString()).toBe('2026-05-04T00:00:00.000Z');
    });

    it('falls back to UTC midnight when tz is unknown', () => {
      const got = tzMidnight('2026-05-04', 'Atlantis/Lost');
      expect(got.toISOString()).toBe('2026-05-04T00:00:00.000Z');
    });

    it('throws on malformed YYYY-MM-DD', () => {
      expect(() => tzMidnight('2026/05/04', 'UTC')).toThrow();
      expect(() => tzMidnight('not-a-date', 'UTC')).toThrow();
    });

    it('handles a Monday on the week-start use case', () => {
      // Mon May 4 2026 in America/Chicago (CDT, -5) → 05:00Z.
      const got = tzMidnight('2026-05-04', 'America/Chicago');
      expect(got.toISOString()).toBe('2026-05-04T05:00:00.000Z');
    });
  });

  describe('addCalendarDays', () => {
    it('adds 7 days across spring-forward in Los_Angeles (week is 167h)', () => {
      // Mar 8 2026 is the spring-forward day in LA. The week starting
      // Mon Mar 2 2026 (08:00Z, PST) ends Mon Mar 9 2026 (07:00Z, PDT)
      // — 167 hours, not 168.
      const start = tzMidnight('2026-03-02', 'America/Los_Angeles');
      const end = addCalendarDays(start, 7, 'America/Los_Angeles');
      expect(start.toISOString()).toBe('2026-03-02T08:00:00.000Z');
      expect(end.toISOString()).toBe('2026-03-09T07:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(167 * 60 * 60 * 1000);
    });

    it('adds 7 days across fall-back in New_York (week is 169h)', () => {
      // Nov 1 2026 is the fall-back day in NY. The week starting
      // Mon Oct 26 2026 (04:00Z, EDT) ends Mon Nov 2 2026 (05:00Z, EST)
      // — 169 hours.
      const start = tzMidnight('2026-10-26', 'America/New_York');
      const end = addCalendarDays(start, 7, 'America/New_York');
      expect(start.toISOString()).toBe('2026-10-26T04:00:00.000Z');
      expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(169 * 60 * 60 * 1000);
    });

    it('adds 7 days exactly outside DST transitions', () => {
      const start = tzMidnight('2026-05-04', 'America/Los_Angeles');
      const end = addCalendarDays(start, 7, 'America/Los_Angeles');
      expect(end.toISOString()).toBe('2026-05-11T07:00:00.000Z');
      expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('falls back to fixed-millisecond add for unknown tz', () => {
      const start = new Date('2026-05-04T00:00:00Z');
      const end = addCalendarDays(start, 7, 'Atlantis/Lost');
      expect(end.toISOString()).toBe('2026-05-11T00:00:00.000Z');
    });
  });

  it('isValidTimezone: known and unknown', () => {
    expect(isValidTimezone('America/Los_Angeles')).toBe(true);
    expect(isValidTimezone('Atlantis/Lost')).toBe(false);
  });
});
