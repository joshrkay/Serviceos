import { describe, it, expect } from 'vitest';
import {
  computeOccurrences,
  describeRecurrence,
  isValidDateString,
  validateRecurrenceRule,
} from '../../src/recurring-jobs/recurrence';

describe('recurrence engine (R-JOB)', () => {
  it('validates date strings and rejects rolled-over dates', () => {
    expect(isValidDateString('2026-01-31')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false); // would roll to March
    expect(isValidDateString('2026-1-1')).toBe(false);
    expect(isValidDateString('not-a-date')).toBe(false);
  });

  it('validates rules', () => {
    expect(validateRecurrenceRule({ frequency: 'weekly', interval: 1 })).toHaveLength(0);
    expect(validateRecurrenceRule({ frequency: 'nope' })).toContain(
      'frequency must be one of: daily, weekly, biweekly, monthly',
    );
    expect(validateRecurrenceRule({ frequency: 'weekly', interval: 0 })).toContain(
      'interval must be a positive integer',
    );
    expect(
      validateRecurrenceRule({ frequency: 'weekly', count: 3, until: '2026-12-31' }),
    ).toContain('set either count or until, not both');
  });

  it('generates weekly occurrences bounded by count', () => {
    expect(computeOccurrences('2026-06-01', { frequency: 'weekly', interval: 1, count: 3 }, 10)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
    ]);
  });

  it('honors interval (every 2 weeks) and biweekly', () => {
    expect(
      computeOccurrences('2026-06-01', { frequency: 'weekly', interval: 2, count: 3 }, 10),
    ).toEqual(['2026-06-01', '2026-06-15', '2026-06-29']);
    expect(
      computeOccurrences('2026-06-01', { frequency: 'biweekly', interval: 1, count: 3 }, 10),
    ).toEqual(['2026-06-01', '2026-06-15', '2026-06-29']);
  });

  it('generates daily occurrences', () => {
    expect(computeOccurrences('2026-06-01', { frequency: 'daily', interval: 1, count: 3 }, 10)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
    ]);
  });

  it('clamps monthly occurrences to month length (Jan 31 → Feb 28)', () => {
    expect(
      computeOccurrences('2026-01-31', { frequency: 'monthly', interval: 1, count: 4 }, 10),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('handles a leap-year February (2028)', () => {
    expect(
      computeOccurrences('2028-01-31', { frequency: 'monthly', interval: 1, count: 2 }, 10),
    ).toEqual(['2028-01-31', '2028-02-29']);
  });

  it('stops at `until` (inclusive)', () => {
    expect(
      computeOccurrences('2026-06-01', { frequency: 'weekly', interval: 1, until: '2026-06-15' }, 50),
    ).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });

  it('caps an unbounded rule by `limit`', () => {
    const out = computeOccurrences('2026-06-01', { frequency: 'daily', interval: 1 }, 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('2026-06-01');
  });

  it('count and limit interact — limit wins when smaller', () => {
    expect(
      computeOccurrences('2026-06-01', { frequency: 'weekly', interval: 1, count: 100 }, 2),
    ).toEqual(['2026-06-01', '2026-06-08']);
  });

  it('throws on a bad anchor or rule', () => {
    expect(() => computeOccurrences('2026-13-01', { frequency: 'weekly', interval: 1 }, 5)).toThrow();
    expect(() => computeOccurrences('2026-06-01', { frequency: 'x' as never, interval: 1 }, 5)).toThrow();
  });

  it('describes a rule for the UI', () => {
    expect(describeRecurrence({ frequency: 'weekly', interval: 1 })).toBe('Every week');
    expect(describeRecurrence({ frequency: 'weekly', interval: 2 })).toBe('Every 2 weeks');
    expect(describeRecurrence({ frequency: 'biweekly', interval: 1 })).toBe('Every 2 weeks');
    expect(describeRecurrence({ frequency: 'monthly', interval: 1, count: 6 })).toBe(
      'Every month, 6 times',
    );
    expect(describeRecurrence({ frequency: 'daily', interval: 3, until: '2026-12-31' })).toBe(
      'Every 3 days, until 2026-12-31',
    );
  });
});
