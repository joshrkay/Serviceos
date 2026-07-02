import { describe, it, expect } from 'vitest';
import { resolveScheduleSlot, nextWeekdayIso } from './resolve-schedule-slot';

// A fixed UTC instant for "now". Today/Tomorrow resolve from the calendar day
// in the TENANT tz, so a fixed instant keeps them deterministic regardless of
// the runner's clock. 2026-06-30 13:00Z is 09:00 ET on Jun 30 (a Tuesday).
const NOW = new Date('2026-06-30T13:00:00Z');
// All test dates (Jun 30 – Aug 15 2026) fall in EDT, so ET = UTC-4. Asserting
// on the UTC ISO instant is deterministic regardless of the runner's timezone.
const ET = 'America/New_York';

describe('resolveScheduleSlot', () => {
  it('resolves Today + a time to a one-hour instant range in the tenant tz', () => {
    const slot = resolveScheduleSlot('Today', '2:00 PM', ET, NOW);
    expect(slot).not.toBeNull();
    // 2 PM ET on 2026-06-30 → 18:00Z.
    expect(slot!.scheduledStart).toBe('2026-06-30T18:00:00.000Z');
    expect(slot!.scheduledEnd).toBe('2026-06-30T19:00:00.000Z');
  });

  it('interprets the wall clock in the TENANT tz, not the browser tz', () => {
    // Same wall clock, different tenant zones → different UTC instants.
    const et = resolveScheduleSlot('Today', '2:00 PM', 'America/New_York', NOW);
    const pt = resolveScheduleSlot('Today', '2:00 PM', 'America/Los_Angeles', NOW);
    expect(et!.scheduledStart).toBe('2026-06-30T18:00:00.000Z'); // 2 PM EDT
    expect(pt!.scheduledStart).toBe('2026-06-30T21:00:00.000Z'); // 2 PM PDT
  });

  it('resolves Tomorrow to the next calendar day', () => {
    const slot = resolveScheduleSlot('Tomorrow', '8:00 AM', ET, NOW);
    expect(slot!.scheduledStart).toBe('2026-07-01T12:00:00.000Z'); // 8 AM ET
  });

  it('resolves Today/Tomorrow from the TENANT calendar day, not the browser day', () => {
    // 02:00Z on Jun 30 is still Jun 29 (22:00) in ET. "Today" for an ET tenant
    // must be Jun 29, not the browser/UTC Jun 30.
    const lateNight = new Date('2026-06-30T02:00:00Z');
    expect(resolveScheduleSlot('Today', '2:00 PM', ET, lateNight)!.scheduledStart)
      .toBe('2026-06-29T18:00:00.000Z'); // 2 PM ET on Jun 29
    expect(resolveScheduleSlot('Tomorrow', '2:00 PM', ET, lateNight)!.scheduledStart)
      .toBe('2026-06-30T18:00:00.000Z'); // 2 PM ET on Jun 30
  });

  it('resolves a real ISO date from the custom date input', () => {
    const slot = resolveScheduleSlot('2026-08-15', '10:00 AM', ET, NOW);
    expect(slot!.scheduledStart).toBe('2026-08-15T14:00:00.000Z'); // 10 AM ET
  });

  it('handles 12-hour boundaries (12 PM = noon, 12 AM = midnight)', () => {
    expect(resolveScheduleSlot('Today', '12:00 PM', ET, NOW)!.scheduledStart).toBe('2026-06-30T16:00:00.000Z');
    expect(resolveScheduleSlot('Today', '12:00 AM', ET, NOW)!.scheduledStart).toBe('2026-06-30T04:00:00.000Z');
  });

  it('honors a custom duration', () => {
    const slot = resolveScheduleSlot('Today', '9:00 AM', ET, NOW, 90);
    expect(
      new Date(slot!.scheduledEnd).getTime() - new Date(slot!.scheduledStart).getTime(),
    ).toBe(90 * 60_000);
  });

  it('returns null when no time is selected', () => {
    expect(resolveScheduleSlot('Today', '', ET, NOW)).toBeNull();
  });

  it('returns null when no date is selected', () => {
    expect(resolveScheduleSlot('', '2:00 PM', ET, NOW)).toBeNull();
  });

  it('returns null for placeholder/demo date labels (no real calendar date)', () => {
    expect(resolveScheduleSlot('Tue Mar 11', '2:00 PM', ET, NOW)).toBeNull();
    expect(resolveScheduleSlot('Custom', '2:00 PM', ET, NOW)).toBeNull();
    expect(resolveScheduleSlot('__custom', '2:00 PM', ET, NOW)).toBeNull();
  });

  it('returns null for a malformed time', () => {
    expect(resolveScheduleSlot('Today', '25:00 PM', ET, NOW)).toBeNull();
    expect(resolveScheduleSlot('Today', 'noon', ET, NOW)).toBeNull();
  });
});

describe('nextWeekdayIso', () => {
  // NOW (2026-06-30) is a Tuesday (JS dow 2).
  it('returns today when the target weekday is today (today counts)', () => {
    expect(nextWeekdayIso(2, NOW)).toBe('2026-06-30');
  });

  it('returns the next day for tomorrow’s weekday', () => {
    expect(nextWeekdayIso(3, NOW)).toBe('2026-07-01'); // Wednesday
  });

  it('resolves a later weekday this week', () => {
    expect(nextWeekdayIso(5, NOW)).toBe('2026-07-03'); // Friday
  });

  it('wraps to next week for an earlier weekday', () => {
    expect(nextWeekdayIso(1, NOW)).toBe('2026-07-06'); // Monday
  });

  it('produces a value resolveScheduleSlot can schedule', () => {
    const slot = resolveScheduleSlot(nextWeekdayIso(5, NOW), '10:00 AM', ET, NOW);
    expect(slot!.scheduledStart).toBe('2026-07-03T14:00:00.000Z'); // 10 AM ET, Fri Jul 3
  });
});
