import { describe, expect, it } from 'vitest';
import { agreementCustomerName, humanizeRecurrence } from './agreements';

describe('humanizeRecurrence', () => {
  it('labels the common single-interval frequencies', () => {
    expect(humanizeRecurrence('FREQ=DAILY')).toBe('Daily');
    expect(humanizeRecurrence('FREQ=WEEKLY')).toBe('Weekly');
    expect(humanizeRecurrence('FREQ=MONTHLY')).toBe('Monthly');
    expect(humanizeRecurrence('FREQ=QUARTERLY')).toBe('Quarterly');
    expect(humanizeRecurrence('FREQ=YEARLY')).toBe('Yearly');
    // ANNUALLY is an accepted alias for YEARLY.
    expect(humanizeRecurrence('FREQ=ANNUALLY')).toBe('Yearly');
  });

  it('renders "Every N <unit>" for INTERVAL > 1', () => {
    expect(humanizeRecurrence('FREQ=WEEKLY;INTERVAL=2')).toBe('Every 2 weeks');
    expect(humanizeRecurrence('FREQ=MONTHLY;INTERVAL=3')).toBe('Every 3 months');
    expect(humanizeRecurrence('FREQ=QUARTERLY;INTERVAL=2')).toBe('Every 2 quarters');
    expect(humanizeRecurrence('FREQ=YEARLY;INTERVAL=2')).toBe('Every 2 years');
    expect(humanizeRecurrence('FREQ=DAILY;INTERVAL=10')).toBe('Every 10 days');
  });

  it('treats INTERVAL=1 the same as no interval', () => {
    expect(humanizeRecurrence('FREQ=MONTHLY;INTERVAL=1')).toBe('Monthly');
  });

  it('is case-insensitive on keys and values', () => {
    expect(humanizeRecurrence('freq=monthly;interval=2')).toBe('Every 2 months');
  });

  it('ignores extra RRULE parts it does not need (BYMONTHDAY)', () => {
    expect(humanizeRecurrence('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Monthly');
    expect(humanizeRecurrence('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31')).toBe('Every 2 months');
  });

  it('falls back to the raw rule for anything unusual', () => {
    // Unknown/absent FREQ.
    expect(humanizeRecurrence('FREQ=HOURLY')).toBe('FREQ=HOURLY');
    expect(humanizeRecurrence('BYMONTHDAY=15')).toBe('BYMONTHDAY=15');
    // Malformed segment (no '=').
    expect(humanizeRecurrence('FREQ=MONTHLY;GARBAGE')).toBe('FREQ=MONTHLY;GARBAGE');
    // Non-positive-integer INTERVAL.
    expect(humanizeRecurrence('FREQ=MONTHLY;INTERVAL=0')).toBe('FREQ=MONTHLY;INTERVAL=0');
    expect(humanizeRecurrence('FREQ=MONTHLY;INTERVAL=abc')).toBe('FREQ=MONTHLY;INTERVAL=abc');
  });

  it('returns empty string for empty/nullish input', () => {
    expect(humanizeRecurrence('')).toBe('');
    expect(humanizeRecurrence('   ')).toBe('');
    expect(humanizeRecurrence(null)).toBe('');
    expect(humanizeRecurrence(undefined)).toBe('');
  });
});

describe('agreementCustomerName', () => {
  it('prefers displayName, then first+last, else undefined', () => {
    expect(agreementCustomerName({ displayName: 'Acme Co' })).toBe('Acme Co');
    expect(agreementCustomerName({ firstName: 'Jane', lastName: 'Doe' })).toBe('Jane Doe');
    expect(agreementCustomerName({ firstName: 'Jane' })).toBe('Jane');
    expect(agreementCustomerName({})).toBeUndefined();
    expect(agreementCustomerName(undefined)).toBeUndefined();
  });
});
