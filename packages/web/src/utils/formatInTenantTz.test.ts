import { describe, expect, it } from 'vitest';
import {
  formatInTenantTz,
  formatDateInTenantTz,
  formatDateTimeInTenantTz,
  formatTimeInTenantTz,
  tenantWallClockToUtc,
  todayInTz,
  dateKeyInTz,
  dayWindowUtc,
  utcToTenantWallClock,
} from './formatInTenantTz';

/**
 * CLAUDE.md core pattern: "All times: stored UTC, rendered in tenant
 * timezone". These tests pin a few well-known UTC instants and verify
 * that each formatter renders them in the supplied IANA timezone — NOT
 * the test runner's local zone (which varies per CI machine).
 *
 * 2026-05-28T17:00:00Z is 1:00 PM EDT (America/New_York) and 10:00 AM
 * PDT (America/Los_Angeles); we use that for the cross-zone proof.
 */

const UTC_AFTERNOON = '2026-05-28T17:00:00Z';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

describe('formatInTenantTz', () => {
  it('renders the same instant differently in NY vs LA', () => {
    const ny = formatInTenantTz(UTC_AFTERNOON, NY, { hour: 'numeric', minute: '2-digit' });
    const la = formatInTenantTz(UTC_AFTERNOON, LA, { hour: 'numeric', minute: '2-digit' });
    expect(ny).toBe('1:00 PM');
    expect(la).toBe('10:00 AM');
  });

  it('accepts Date / ISO string / epoch ms as input', () => {
    const ms = new Date(UTC_AFTERNOON).getTime();
    expect(formatInTenantTz(new Date(UTC_AFTERNOON), NY, { hour: 'numeric' })).toBe('1 PM');
    expect(formatInTenantTz(UTC_AFTERNOON, NY, { hour: 'numeric' })).toBe('1 PM');
    expect(formatInTenantTz(ms, NY, { hour: 'numeric' })).toBe('1 PM');
  });

  it('returns "" for an invalid date input rather than throwing', () => {
    expect(formatInTenantTz('not a date', NY, { hour: 'numeric' })).toBe('');
  });
});

describe('formatDateInTenantTz', () => {
  it('renders short month/day in the tenant tz', () => {
    expect(formatDateInTenantTz(UTC_AFTERNOON, NY)).toBe('May 28');
    expect(formatDateInTenantTz(UTC_AFTERNOON, LA)).toBe('May 28');
  });

  it('renders different dates when the UTC instant crosses midnight in the target tz', () => {
    // 2026-01-01T07:00:00Z = 23:00 Dec 31 in LA (UTC-8) and 02:00 Jan 1
    // in NY (UTC-5). A single UTC instant lands on different calendar
    // dates depending on the tenant's tz — the core thing the
    // formatter needs to get right.
    const instant = '2026-01-01T07:00:00Z';
    expect(formatDateInTenantTz(instant, LA, { withYear: true })).toBe('Dec 31, 2025');
    expect(formatDateInTenantTz(instant, NY, { withYear: true })).toBe('Jan 1, 2026');
  });

  it('opt-in year', () => {
    expect(formatDateInTenantTz(UTC_AFTERNOON, NY, { withYear: true })).toBe('May 28, 2026');
  });
});

describe('formatTimeInTenantTz', () => {
  it('renders hour:minute in the tenant tz', () => {
    expect(formatTimeInTenantTz(UTC_AFTERNOON, NY)).toBe('1:00 PM');
    expect(formatTimeInTenantTz(UTC_AFTERNOON, LA)).toBe('10:00 AM');
  });
});

describe('formatDateTimeInTenantTz', () => {
  it('renders date + time in the tenant tz', () => {
    expect(formatDateTimeInTenantTz(UTC_AFTERNOON, NY)).toBe('May 28, 2026, 1:00 PM');
    expect(formatDateTimeInTenantTz(UTC_AFTERNOON, LA)).toBe('May 28, 2026, 10:00 AM');
  });
});

/**
 * Journey QA 2026-07-02 (bug 4) — the input-side inverse: a wall-clock time
 * entered in the UI is TENANT-local, so posting it must convert tenant tz →
 * UTC (not browser tz → UTC). These pins are independent of the runner's
 * local zone by construction (explicit IANA zones, asserted against ISO/UTC).
 */
describe('tenantWallClockToUtc', () => {
  it('converts a tenant-local wall clock to the correct UTC instant (EDT)', () => {
    // The journey repro: 14:00 entered for a New-York tenant on Jul 2 must
    // store 18:00Z (EDT, UTC-4) — NOT 14:00Z.
    expect(tenantWallClockToUtc('2026-07-02', '14:00', NY).toISOString()).toBe(
      '2026-07-02T18:00:00.000Z',
    );
    expect(tenantWallClockToUtc('2026-07-02', '14:00', LA).toISOString()).toBe(
      '2026-07-02T21:00:00.000Z',
    );
  });

  it('is the exact inverse of formatTimeInTenantTz', () => {
    const utc = tenantWallClockToUtc('2026-07-02', '14:00', NY);
    expect(formatTimeInTenantTz(utc, NY)).toBe('2:00 PM');
  });

  it('UTC tenant: wall clock IS the instant', () => {
    expect(tenantWallClockToUtc('2026-07-02', '09:30', 'UTC').toISOString()).toBe(
      '2026-07-02T09:30:00.000Z',
    );
  });

  it('DST boundary (spring forward, US 2026-03-08): offsets flip across the day', () => {
    // 01:00 is still EST (UTC-5); 14:00 the same day is EDT (UTC-4).
    expect(tenantWallClockToUtc('2026-03-08', '01:00', NY).toISOString()).toBe(
      '2026-03-08T06:00:00.000Z',
    );
    expect(tenantWallClockToUtc('2026-03-08', '14:00', NY).toISOString()).toBe(
      '2026-03-08T18:00:00.000Z',
    );
  });

  it('DST boundary (fall back, US 2026-11-01): offsets flip across the day', () => {
    // 00:30 is still EDT (UTC-4); 14:00 the same day is EST (UTC-5).
    expect(tenantWallClockToUtc('2026-11-01', '00:30', NY).toISOString()).toBe(
      '2026-11-01T04:30:00.000Z',
    );
    expect(tenantWallClockToUtc('2026-11-01', '14:00', NY).toISOString()).toBe(
      '2026-11-01T19:00:00.000Z',
    );
  });

  it('a nonexistent spring-forward wall clock lands on a nearby valid instant (no throw/NaN)', () => {
    // 02:30 on 2026-03-08 does not exist in America/New_York.
    const d = tenantWallClockToUtc('2026-03-08', '02:30', NY);
    expect(Number.isNaN(d.getTime())).toBe(false);
    // Within the hour surrounding the gap (06:30Z EST-interpretation ±1h).
    expect(Math.abs(d.getTime() - Date.UTC(2026, 2, 8, 6, 30))).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
  });

  it('returns an invalid Date for malformed input', () => {
    expect(Number.isNaN(tenantWallClockToUtc('garbage', '14:00', NY).getTime())).toBe(true);
    expect(Number.isNaN(tenantWallClockToUtc('2026-07-02', 'nope', NY).getTime())).toBe(true);
  });
});

/**
 * U8 — day-keyed queries, day windows, and datetime-local round-trips must all
 * derive from the TENANT timezone. IST (Asia/Kolkata, UTC+5:30, no DST) is the
 * positive-offset case; NY is the negative-offset + DST case. The two US DST
 * transition days (2026-03-08 spring forward = 23h; 2026-11-01 fall back = 25h)
 * pin that day boundaries use calendar arithmetic, not a fixed +24h.
 */
const IST = 'Asia/Kolkata';

describe('todayInTz', () => {
  it('formats a YYYY-MM-DD key and agrees with dateKeyInTz(now)', () => {
    expect(todayInTz(NY)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Same instant, same tz → same calendar day.
    expect(todayInTz(NY)).toBe(dateKeyInTz(new Date(), NY));
    expect(todayInTz('UTC')).toBe(dateKeyInTz(new Date(), 'UTC'));
  });
});

describe('dateKeyInTz', () => {
  it('keys the calendar day in the tenant tz, not UTC', () => {
    // 2026-01-01T07:00:00Z = 23:00 Dec 31 in LA (UTC-8), 02:00 Jan 1 in NY.
    const instant = '2026-01-01T07:00:00Z';
    expect(dateKeyInTz(instant, LA)).toBe('2025-12-31');
    expect(dateKeyInTz(instant, NY)).toBe('2026-01-01');
    expect(dateKeyInTz(instant, 'UTC')).toBe('2026-01-01');
  });

  it('positive-offset zone (IST) rolls forward across UTC midnight', () => {
    // 18:00Z is 23:30 IST same day; 20:00Z is 01:30 IST the NEXT day.
    expect(dateKeyInTz('2026-06-15T18:00:00Z', IST)).toBe('2026-06-15');
    expect(dateKeyInTz('2026-06-15T20:00:00Z', IST)).toBe('2026-06-16');
  });

  it('negative-offset zone rolls back across UTC midnight (23:00 local)', () => {
    // 23:00 on 2026-01-15 in LA (PST, UTC-8) is 07:00Z on 2026-01-16.
    expect(dateKeyInTz('2026-01-16T07:00:00Z', LA)).toBe('2026-01-15');
  });

  it('resolves the calendar day on the DST transition days', () => {
    // Noon UTC on each transition day is unambiguously that local day in NY.
    expect(dateKeyInTz('2026-03-08T12:00:00Z', NY)).toBe('2026-03-08');
    expect(dateKeyInTz('2026-11-01T12:00:00Z', NY)).toBe('2026-11-01');
  });

  it('accepts Date / epoch ms and returns "" for invalid input', () => {
    expect(dateKeyInTz(new Date('2026-05-28T17:00:00Z'), NY)).toBe('2026-05-28');
    expect(dateKeyInTz(new Date('2026-05-28T17:00:00Z').getTime(), NY)).toBe('2026-05-28');
    expect(dateKeyInTz('not a date', NY)).toBe('');
  });
});

describe('dayWindowUtc', () => {
  it('UTC tenant: the window is the plain calendar day', () => {
    expect(dayWindowUtc('2026-05-28', 'UTC')).toEqual({
      startUtc: '2026-05-28T00:00:00.000Z',
      endUtc: '2026-05-29T00:00:00.000Z',
    });
  });

  it('negative-offset zone (NY, EDT): window is shifted +4h', () => {
    expect(dayWindowUtc('2026-05-28', NY)).toEqual({
      startUtc: '2026-05-28T04:00:00.000Z',
      endUtc: '2026-05-29T04:00:00.000Z',
    });
  });

  it('positive-offset zone (IST): window starts the prior UTC evening', () => {
    expect(dayWindowUtc('2026-06-15', IST)).toEqual({
      startUtc: '2026-06-14T18:30:00.000Z',
      endUtc: '2026-06-15T18:30:00.000Z',
    });
  });

  it('spring-forward day (2026-03-08 NY) is only 23h — end is next-midnight, not +24h', () => {
    const { startUtc, endUtc } = dayWindowUtc('2026-03-08', NY);
    expect(startUtc).toBe('2026-03-08T05:00:00.000Z'); // 00:00 EST
    expect(endUtc).toBe('2026-03-09T04:00:00.000Z'); // 00:00 EDT (next local midnight)
    const hours = (Date.parse(endUtc) - Date.parse(startUtc)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('fall-back day (2026-11-01 NY) is 25h — end computed by calendar arithmetic', () => {
    const { startUtc, endUtc } = dayWindowUtc('2026-11-01', NY);
    expect(startUtc).toBe('2026-11-01T04:00:00.000Z'); // 00:00 EDT
    expect(endUtc).toBe('2026-11-02T05:00:00.000Z'); // 00:00 EST (next local midnight)
    const hours = (Date.parse(endUtc) - Date.parse(startUtc)) / 3_600_000;
    expect(hours).toBe(25);
  });

  it('rolls the window across a month boundary (calendar arithmetic)', () => {
    expect(dayWindowUtc('2026-01-31', 'UTC')).toEqual({
      startUtc: '2026-01-31T00:00:00.000Z',
      endUtc: '2026-02-01T00:00:00.000Z',
    });
  });
});

describe('utcToTenantWallClock', () => {
  it('renders the datetime-local value in the tenant tz', () => {
    expect(utcToTenantWallClock('2026-07-02T18:30:00Z', NY)).toBe('2026-07-02T14:30');
    // 18:30Z is exactly midnight IST → the hour must normalize to 00, not 24.
    expect(utcToTenantWallClock('2026-07-02T18:30:00Z', IST)).toBe('2026-07-03T00:00');
    expect(utcToTenantWallClock('2026-07-02T18:30:00Z', 'UTC')).toBe('2026-07-02T18:30');
  });

  it('returns "" for invalid input', () => {
    expect(utcToTenantWallClock('not a date', NY)).toBe('');
  });

  it('round-trips to the minute via tenantWallClockToUtc across zones and DST', () => {
    const cases: Array<[string, string]> = [
      ['2026-07-02T18:30:00.000Z', NY],
      ['2026-01-15T09:05:00.000Z', LA],
      ['2026-06-15T20:45:00.000Z', IST],
      ['2026-05-28T17:00:00.000Z', 'UTC'],
      // Instants on the two US DST transition days.
      ['2026-03-08T15:30:00.000Z', NY],
      ['2026-11-01T18:15:00.000Z', NY],
    ];
    for (const [iso, tz] of cases) {
      const local = utcToTenantWallClock(iso, tz);
      const [date, time] = local.split('T');
      expect(tenantWallClockToUtc(date, time, tz).toISOString()).toBe(iso);
    }
  });
});
