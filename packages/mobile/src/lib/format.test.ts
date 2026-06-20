import { describe, expect, it } from 'vitest';
import { formatMoneyCents, formatShortDate } from './format';

describe('formatMoneyCents', () => {
  it('renders integer cents as dollars with thousands separators', () => {
    expect(formatMoneyCents(0)).toBe('$0.00');
    expect(formatMoneyCents(5)).toBe('$0.05');
    expect(formatMoneyCents(12345)).toBe('$123.45');
    expect(formatMoneyCents(123456789)).toBe('$1,234,567.89');
    expect(formatMoneyCents(-2000)).toBe('-$20.00');
  });
});

describe('formatShortDate', () => {
  it('renders a date in the given timezone', () => {
    // 2026-06-20T02:00:00Z is still Jun 19 in America/New_York (UTC-4).
    expect(formatShortDate('2026-06-20T02:00:00Z', 'America/New_York')).toBe('Jun 19, 2026');
    expect(formatShortDate('2026-06-20T12:00:00Z', 'America/New_York')).toBe('Jun 20, 2026');
  });

  it('returns empty for null/invalid input', () => {
    expect(formatShortDate(null)).toBe('');
    expect(formatShortDate(undefined)).toBe('');
    expect(formatShortDate('not-a-date')).toBe('');
  });
});
