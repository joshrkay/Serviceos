import { describe, expect, it } from 'vitest';
import {
  formatInTenantTz,
  formatDateInTenantTz,
  formatDateTimeInTenantTz,
  formatTimeInTenantTz,
  tenantWallClockToUtc,
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
