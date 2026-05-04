import { describe, it, expect } from 'vitest';
import { parseRule, nextOccurrence, RecurrenceRuleError } from '../../src/agreements/recurrence';

describe('P9-003 recurrence: parseRule', () => {
  it('parses a basic monthly rule', () => {
    expect(parseRule('FREQ=MONTHLY')).toEqual({
      freq: 'monthly',
      interval: 1,
      byMonthDay: undefined,
    });
  });

  it('parses interval and byMonthDay', () => {
    expect(parseRule('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15')).toEqual({
      freq: 'monthly',
      interval: 3,
      byMonthDay: 15,
    });
  });

  it('parses quarterly and yearly', () => {
    expect(parseRule('FREQ=QUARTERLY').freq).toBe('quarterly');
    expect(parseRule('FREQ=YEARLY').freq).toBe('yearly');
  });

  it('rejects unknown frequencies', () => {
    expect(() => parseRule('FREQ=DAILY')).toThrow(RecurrenceRuleError);
  });

  it('rejects missing FREQ', () => {
    expect(() => parseRule('INTERVAL=1')).toThrow(RecurrenceRuleError);
  });

  it('rejects malformed segments', () => {
    expect(() => parseRule('FREQ=MONTHLY;BADSEGMENT')).toThrow(RecurrenceRuleError);
  });

  it('rejects non-positive intervals', () => {
    expect(() => parseRule('FREQ=MONTHLY;INTERVAL=0')).toThrow(RecurrenceRuleError);
    expect(() => parseRule('FREQ=MONTHLY;INTERVAL=-1')).toThrow(RecurrenceRuleError);
  });

  it('rejects out-of-range BYMONTHDAY', () => {
    expect(() => parseRule('FREQ=MONTHLY;BYMONTHDAY=32')).toThrow(RecurrenceRuleError);
    expect(() => parseRule('FREQ=MONTHLY;BYMONTHDAY=0')).toThrow(RecurrenceRuleError);
  });
});

describe('P9-003 recurrence: nextOccurrence', () => {
  it('monthly on the 15th, advances by one month', () => {
    const from = new Date(Date.UTC(2026, 0, 15)); // 2026-01-15
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', from);
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-15');
  });

  it('quarterly with INTERVAL=1 advances 3 months', () => {
    const from = new Date(Date.UTC(2026, 0, 15));
    const next = nextOccurrence('FREQ=QUARTERLY;BYMONTHDAY=15', from);
    expect(next.toISOString().slice(0, 10)).toBe('2026-04-15');
  });

  it('yearly anchors on same month-day next year', () => {
    const from = new Date(Date.UTC(2026, 4, 1));
    const next = nextOccurrence('FREQ=YEARLY;BYMONTHDAY=1', from);
    expect(next.toISOString().slice(0, 10)).toBe('2027-05-01');
  });

  it('Feb 29 → Feb 28 in non-leap years (BYMONTHDAY=29)', () => {
    // Jan 31 2025 + monthly with BYMONTHDAY=29 → Feb 28 2025 (non-leap).
    const from = new Date(Date.UTC(2025, 0, 30));
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=29', from);
    expect(next.toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('Feb 29 lands correctly in leap years', () => {
    const from = new Date(Date.UTC(2024, 0, 30));
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=29', from);
    expect(next.toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('BYMONTHDAY=31 clamps to month-end', () => {
    // From Jan 31 → next monthly on day 31 → Feb 28 (2025 non-leap)
    const from = new Date(Date.UTC(2025, 0, 31));
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', from);
    expect(next.toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('BYMONTHDAY=31 → April 30 (April has 30 days)', () => {
    const from = new Date(Date.UTC(2025, 2, 31)); // March 31
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31', from);
    expect(next.toISOString().slice(0, 10)).toBe('2025-04-30');
  });

  it('uses fromDate.day when BYMONTHDAY is unset', () => {
    const from = new Date(Date.UTC(2026, 0, 7));
    const next = nextOccurrence('FREQ=MONTHLY', from);
    expect(next.toISOString().slice(0, 10)).toBe('2026-02-07');
  });

  it('always returns a date strictly after fromDate', () => {
    // If we ask for the next occurrence on the same day, we should
    // get the *next* cycle, not "today".
    const from = new Date(Date.UTC(2026, 5, 15));
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15', from);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('quarterly Feb 29 anchor → May 29', () => {
    const from = new Date(Date.UTC(2024, 1, 29));
    const next = nextOccurrence('FREQ=QUARTERLY;BYMONTHDAY=29', from);
    expect(next.toISOString().slice(0, 10)).toBe('2024-05-29');
  });
});
