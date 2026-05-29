import { describe, expect, it } from 'vitest';
import {
  formatInTenantTz,
  formatDateInTenantTz,
  formatDateTimeInTenantTz,
  formatTimeInTenantTz,
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
