import { describe, expect, it } from 'vitest';
import { describeRecurrence } from './recurrence';

describe('describeRecurrence', () => {
  it('labels the base frequencies', () => {
    expect(describeRecurrence('FREQ=MONTHLY')).toBe('Monthly');
    expect(describeRecurrence('FREQ=QUARTERLY')).toBe('Quarterly');
    expect(describeRecurrence('FREQ=YEARLY')).toBe('Yearly');
  });

  it('pluralizes an interval greater than one', () => {
    expect(describeRecurrence('FREQ=MONTHLY;INTERVAL=3')).toBe('Every 3 months');
    expect(describeRecurrence('FREQ=YEARLY;INTERVAL=2')).toBe('Every 2 years');
  });

  it('appends the month day', () => {
    expect(describeRecurrence('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Monthly on day 15');
    expect(describeRecurrence('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1')).toBe('Every 2 months on day 1');
  });

  it('returns the raw rule when it is not the recognized subset', () => {
    expect(describeRecurrence('FREQ=WEEKLY')).toBe('FREQ=WEEKLY');
  });

  it('returns empty string for no rule', () => {
    expect(describeRecurrence(undefined)).toBe('');
    expect(describeRecurrence('')).toBe('');
  });
});
