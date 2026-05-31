import { describe, it, expect } from 'vitest';
import {
  resolveDateTime,
  formatForReadback,
  DEFAULT_TENANT_TIMEZONE,
} from '../../../src/ai/scheduling/resolve-datetime';

// Anchor: Monday 2026-06-01, noon UTC (= 08:00 EDT / 05:00 PDT). June is
// daylight-saving for both NY (EDT, UTC-4) and LA (PDT, UTC-7), which keeps
// the expected UTC offsets fixed and the assertions deterministic.
const NOW = new Date('2026-06-01T12:00:00.000Z');

describe('resolveDateTime', () => {
  it('resolves an explicit time in the tenant timezone (the core bug fix)', () => {
    const ny = resolveDateTime('tomorrow at 2pm', {
      timezone: 'America/New_York',
      now: NOW,
    });
    expect(ny.ok).toBe(true);
    if (ny.ok) {
      // 2pm EDT on Tue Jun 2 == 18:00Z
      expect(ny.startUtc).toBe('2026-06-02T18:00:00.000Z');
      expect(ny.endUtc).toBe('2026-06-02T19:00:00.000Z'); // default 60m
      expect(ny.precision).toBe('exact');
    }
  });

  it('produces a DIFFERENT UTC instant for a different tenant timezone', () => {
    const la = resolveDateTime('tomorrow at 2pm', {
      timezone: 'America/Los_Angeles',
      now: NOW,
    });
    expect(la.ok).toBe(true);
    if (la.ok) {
      // 2pm PDT on Tue Jun 2 == 21:00Z (proves we no longer hardcode LA for NY)
      expect(la.startUtc).toBe('2026-06-02T21:00:00.000Z');
    }
  });

  it('falls back to the product-default timezone for an invalid zone', () => {
    const r = resolveDateTime('tomorrow at 9am', { timezone: 'Mars/Olympus', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.timezone).toBe(DEFAULT_TENANT_TIMEZONE);
      expect(r.startUtc).toBe('2026-06-02T13:00:00.000Z'); // 9am EDT
    }
  });

  it('treats a bare date with no time as ambiguous (asks instead of guessing)', () => {
    const r = resolveDateTime('next Tuesday', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous_no_time');
  });

  it('resolves a daypart to an arrival window', () => {
    const r = resolveDateTime('tomorrow morning', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.precision).toBe('daypart');
      expect(r.startUtc).toBe('2026-06-02T12:00:00.000Z'); // 8am EDT
      expect(r.arrivalWindowStartUtc).toBe('2026-06-02T12:00:00.000Z'); // 8am EDT
      expect(r.arrivalWindowEndUtc).toBe('2026-06-02T16:00:00.000Z'); // 12pm EDT
    }
  });

  it('rejects times in the past', () => {
    const r = resolveDateTime('yesterday at 9am', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('in_past');
  });

  it('rejects empty input', () => {
    const r = resolveDateTime('   ', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty');
  });

  it('reports unparseable phrases', () => {
    const r = resolveDateTime('fhqwhgads', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unparseable');
  });

  it('honors an explicit end time', () => {
    const r = resolveDateTime('tomorrow from 2pm to 4pm', {
      timezone: 'America/New_York',
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe('2026-06-02T18:00:00.000Z'); // 2pm EDT
      expect(r.endUtc).toBe('2026-06-02T20:00:00.000Z'); // 4pm EDT
    }
  });

  it('renders a tenant-local read-back string', () => {
    const s = formatForReadback('2026-06-02T18:00:00.000Z', 'America/New_York');
    expect(s).toContain('2:00');
    expect(s).toContain('Tuesday');
  });
});
