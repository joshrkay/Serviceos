import { describe, it, expect } from 'vitest';
import {
  resolveDateTime,
  resolveSpokenDay,
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

  it('biases a bare 1–7 hour to PM (service hours) — "tomorrow at 5" → 5pm not 5am', () => {
    const r = resolveDateTime('tomorrow at 5', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe('2026-06-02T21:00:00.000Z'); // 5pm EDT, not 5am (09:00Z)
    }
  });

  it('leaves a bare 8–12 hour as spoken (morning) — "tomorrow at 8" → 8am', () => {
    const r = resolveDateTime('tomorrow at 8', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe('2026-06-02T12:00:00.000Z'); // 8am EDT
    }
  });

  it('honors an explicit am/pm over the bias — "tomorrow at 5am" stays 5am', () => {
    const r = resolveDateTime('tomorrow at 5am', { timezone: 'America/New_York', now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.startUtc).toBe('2026-06-02T09:00:00.000Z'); // 5am EDT
    }
  });

  it('renders a tenant-local read-back string', () => {
    const s = formatForReadback('2026-06-02T18:00:00.000Z', 'America/New_York');
    expect(s).toContain('2:00');
    expect(s).toContain('Tuesday');
  });
});

// (2026-08-09, Task 10 quality-review C1) — resolveSpokenDay is the
// lookup-side sibling of resolveDateTime: it must ACCEPT every bare-day
// phrase resolveDateTime correctly REFUSES for booking. NOW is a Thursday
// so the exact phrases the review probed are pinned verbatim.
describe('resolveSpokenDay', () => {
  // Thursday 2026-06-11, 07:00 America/New_York (11:00 UTC).
  const NOW_THU = new Date('2026-06-11T11:00:00.000Z');

  it('resolves a bare weekday that IS today to today\'s date key', () => {
    expect(resolveSpokenDay('Thursday', { timezone: 'America/New_York', now: NOW_THU })).toBe(
      '2026-06-11',
    );
  });

  it('resolves "tomorrow" (bare, no time-of-day) — resolveDateTime refuses this exact phrase', () => {
    expect(resolveSpokenDay('tomorrow', { timezone: 'America/New_York', now: NOW_THU })).toBe(
      '2026-06-12',
    );
    // Pin the contrast: the booking resolver correctly refuses the same phrase.
    const booking = resolveDateTime('tomorrow', { timezone: 'America/New_York', now: NOW_THU });
    expect(booking.ok).toBe(false);
    if (!booking.ok) expect(booking.reason).toBe('ambiguous_no_time');
  });

  it('resolves "Monday" (bare weekday, forward-looking) — resolveDateTime refuses this exact phrase', () => {
    expect(resolveSpokenDay('Monday', { timezone: 'America/New_York', now: NOW_THU })).toBe(
      '2026-06-15',
    );
    const booking = resolveDateTime('Monday', { timezone: 'America/New_York', now: NOW_THU });
    expect(booking.ok).toBe(false);
    if (!booking.ok) expect(booking.reason).toBe('ambiguous_no_time');
  });

  it('resolves "this Friday" — resolveDateTime refuses this exact phrase', () => {
    expect(resolveSpokenDay('this Friday', { timezone: 'America/New_York', now: NOW_THU })).toBe(
      '2026-06-12',
    );
    const booking = resolveDateTime('this Friday', { timezone: 'America/New_York', now: NOW_THU });
    expect(booking.ok).toBe(false);
    if (!booking.ok) expect(booking.reason).toBe('ambiguous_no_time');
  });

  it('resolves "next week" to a date — resolveDateTime refuses this exact phrase', () => {
    const key = resolveSpokenDay('next week', { timezone: 'America/New_York', now: NOW_THU });
    expect(key).not.toBeNull();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const booking = resolveDateTime('next week', { timezone: 'America/New_York', now: NOW_THU });
    expect(booking.ok).toBe(false);
    if (!booking.ok) expect(booking.reason).toBe('ambiguous_no_time');
  });

  it('resolves a daypart phrase to the same day as the bare weekday ("Thursday afternoon" == today)', () => {
    expect(
      resolveSpokenDay('Thursday afternoon', { timezone: 'America/New_York', now: NOW_THU }),
    ).toBe('2026-06-11');
  });

  it('"next Thursday afternoon" resolves to NEXT WEEK\'s Thursday, not today', () => {
    expect(
      resolveSpokenDay('next Thursday afternoon', { timezone: 'America/New_York', now: NOW_THU }),
    ).toBe('2026-06-18');
  });

  it('returns null for an unparseable phrase — never guesses a day', () => {
    expect(
      resolveSpokenDay('gibberish not a date', { timezone: 'America/New_York', now: NOW_THU }),
    ).toBeNull();
  });

  it('returns null for an empty/absent phrase', () => {
    expect(resolveSpokenDay('', { timezone: 'America/New_York', now: NOW_THU })).toBeNull();
    expect(resolveSpokenDay('   ', { timezone: 'America/New_York', now: NOW_THU })).toBeNull();
  });

  it('anchors to the TENANT timezone, not the server/UTC day', () => {
    // 11:00 UTC Thursday is already Thursday in every US zone, so use a
    // moment where the tenant-local day differs from the UTC day: 02:30
    // UTC on 2026-06-12 (Friday) is still 22:30 Thursday in
    // America/Los_Angeles (PDT, UTC-7).
    const crossMidnightUtc = new Date('2026-06-12T02:30:00.000Z');
    expect(
      resolveSpokenDay('today', { timezone: 'America/Los_Angeles', now: crossMidnightUtc }),
    ).toBe('2026-06-11');
    expect(
      resolveSpokenDay('tomorrow', { timezone: 'America/Los_Angeles', now: crossMidnightUtc }),
    ).toBe('2026-06-12');
  });
});
