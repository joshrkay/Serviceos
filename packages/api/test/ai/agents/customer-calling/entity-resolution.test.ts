import { parseNaturalDatetime } from '../../../../src/ai/agents/customer-calling/entity-resolution';

// QA-2026-06-05 (SCH-02/03) — deterministic NL datetime parsing for the
// calling agent's entity resolution. Fixed "now" so weekday math is stable.
describe('parseNaturalDatetime', () => {
  const now = new Date('2026-06-05T12:00:00Z'); // a Friday

  it('parses "next Tuesday at 2 PM"', () => {
    const w = parseNaturalDatetime('next Tuesday at 2 PM', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(2); // Tuesday
    expect(start.getUTCHours()).toBe(14);
    expect(start.getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(w.scheduledEnd).getTime() - start.getTime()).toBe(60 * 60_000);
  });

  it('parses "tomorrow at 9:30 am"', () => {
    const w = parseNaturalDatetime('tomorrow at 9:30 am', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDate()).toBe(6);
    expect(start.getUTCHours()).toBe(9);
    expect(start.getUTCMinutes()).toBe(30);
  });

  it('bare weekday means the NEXT occurrence (never today)', () => {
    const w = parseNaturalDatetime('friday at 1 pm', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(5);
    expect(start.getUTCDate()).toBe(12); // a week out, not today
  });

  it('time-only gets a future slot', () => {
    const w = parseNaturalDatetime('at 8 am', now)!;
    expect(new Date(w.scheduledStart).getTime()).toBeGreaterThan(now.getTime());
  });

  it('day-only defaults to a morning slot', () => {
    const w = parseNaturalDatetime('next monday', now)!;
    const start = new Date(w.scheduledStart);
    expect(start.getUTCDay()).toBe(1);
    expect(start.getUTCHours()).toBe(9);
  });

  it('returns undefined for unparseable text (never guesses)', () => {
    expect(parseNaturalDatetime('whenever works for you', now)).toBeUndefined();
    expect(parseNaturalDatetime('at 27 pm', now)).toBeUndefined();
  });

  it('12 am / 12 pm edge cases', () => {
    const noon = parseNaturalDatetime('tomorrow at 12 pm', now)!;
    expect(new Date(noon.scheduledStart).getUTCHours()).toBe(12);
    const midnight = parseNaturalDatetime('tomorrow at 12 am', now)!;
    expect(new Date(midnight.scheduledStart).getUTCHours()).toBe(0);
  });
});
