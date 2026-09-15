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

// ---------------------------------------------------------------------------
// SPOKEN clock hours written as words ("Tuesday two o'clock") — register case
// book-02. An operator DICTATING a booking says "two o'clock"; chrono only
// understands "2 o'clock", so the phrase used to come back
// `ambiguous_no_time` and the caller was asked for a time they had just said.
// ---------------------------------------------------------------------------

describe('resolveDateTime — spoken "<word> o\'clock"', () => {
  const TZ = 'America/Phoenix'; // no DST, so the offset is fixed at -7

  it('resolves "Tuesday two o\'clock" to the same instant as "Tuesday 2 o\'clock"', () => {
    const spoken = resolveDateTime("Tuesday two o'clock", { timezone: TZ, now: NOW });
    const digits = resolveDateTime("Tuesday 2 o'clock", { timezone: TZ, now: NOW });
    expect(spoken.ok).toBe(true);
    expect(digits.ok).toBe(true);
    if (spoken.ok && digits.ok) {
      expect(spoken.startUtc).toBe(digits.startUtc);
      expect(spoken.precision).toBe('exact');
      // The bare-hour service bias still applies (1–7 → PM), unchanged.
      expect(spoken.startUtc).toBe('2026-06-02T21:00:00.000Z');
    }
  });

  it('accepts the curly apostrophe and the bare "oclock" spelling', () => {
    for (const phrase of ['Tuesday two o’clock', 'Tuesday two oclock']) {
      const res = resolveDateTime(phrase, { timezone: TZ, now: NOW });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.startUtc).toBe('2026-06-02T21:00:00.000Z');
    }
  });

  it('covers the whole one–twelve range', () => {
    const eleven = resolveDateTime("Tuesday eleven o'clock", { timezone: TZ, now: NOW });
    expect(eleven.ok).toBe(true);
    // 8–12 stay as spoken (a bare "11" is morning) — 11:00 MST = 18:00 UTC.
    if (eleven.ok) expect(eleven.startUtc).toBe('2026-06-02T18:00:00.000Z');
  });

  it('does not touch a number word that is not an hour ("two hours")', () => {
    const res = resolveDateTime('tomorrow at 2pm for two hours', { timezone: TZ, now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.startUtc).toBe('2026-06-02T21:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The SECOND anchor for the same voice-shaped failure: the temporal
// preposition "at". Register case book-03, "Book Smith furnace maintenance
// Tuesday at two" — a mic transcript of the phrasing book-01 writes as
// "Tuesday at 2 pm". Until this landed, the identical booking resolved when
// typed with digits and asked "what time of day?" when dictated, on a surface
// (the assistant's mic button) whose whole job is to accept dictation.
// ---------------------------------------------------------------------------

describe('resolveDateTime — spoken "at <word>"', () => {
  const TZ = 'America/Phoenix'; // no DST, so the offset is fixed at -7

  it('resolves "Tuesday at two" to the same instant as "Tuesday at 2"', () => {
    const spoken = resolveDateTime('Tuesday at two', { timezone: TZ, now: NOW });
    const digits = resolveDateTime('Tuesday at 2', { timezone: TZ, now: NOW });
    expect(spoken.ok).toBe(true);
    expect(digits.ok).toBe(true);
    if (spoken.ok && digits.ok) {
      expect(spoken.startUtc).toBe(digits.startUtc);
      // The bare-hour service bias still applies (1–7 → PM), unchanged.
      expect(spoken.startUtc).toBe('2026-06-02T21:00:00.000Z');
      expect(spoken.precision).toBe('exact');
    }
  });

  it('reads the whole booking sentence, not just the date phrase', () => {
    const res = resolveDateTime('Book Smith furnace maintenance Tuesday at two', {
      timezone: TZ,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.startUtc).toBe('2026-06-02T21:00:00.000Z');
  });

  it('honours an explicit meridiem after the word hour ("at eight am")', () => {
    const res = resolveDateTime('Tuesday at eight am', { timezone: TZ, now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.startUtc).toBe('2026-06-02T15:00:00.000Z');
  });

  it('still asks when the minutes are spoken as words — never books 2:00 for "two thirty"', () => {
    for (const phrase of ['Tuesday at two thirty', 'Tuesday at two fifteen']) {
      const res = resolveDateTime(phrase, { timezone: TZ, now: NOW });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('ambiguous_no_time');
    }
  });

  it('leaves an UNANCHORED number word alone — a bare "two" is still never guessed', () => {
    const res = resolveDateTime('Tuesday two', { timezone: TZ, now: NOW });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('ambiguous_no_time');
  });

  it('does not rewrite "at" followed by a non-hour word', () => {
    const res = resolveDateTime('Tuesday at noon', { timezone: TZ, now: NOW });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.startUtc).toBe('2026-06-02T19:00:00.000Z');
  });
});
