import { describe, expect, it } from 'vitest';
import {
  formatMoneyCents,
  formatMoneyShort,
  formatRelativeTime,
  formatShortDate,
  formatWeekdayDate,
} from './format';

describe('formatMoneyCents', () => {
  it('renders integer cents as dollars with thousands separators', () => {
    expect(formatMoneyCents(0)).toBe('$0.00');
    expect(formatMoneyCents(5)).toBe('$0.05');
    expect(formatMoneyCents(12345)).toBe('$123.45');
    expect(formatMoneyCents(123456789)).toBe('$1,234,567.89');
    expect(formatMoneyCents(-2000)).toBe('-$20.00');
  });
});

describe('formatMoneyShort', () => {
  it('rounds integer cents to whole dollars for dashboard figures', () => {
    expect(formatMoneyShort(0)).toBe('$0');
    expect(formatMoneyShort(12345)).toBe('$123'); // 123.45 → 123
    expect(formatMoneyShort(12999)).toBe('$130'); // rounds up
    expect(formatMoneyShort(123456789)).toBe('$1,234,568');
    expect(formatMoneyShort(-20000)).toBe('-$200');
    expect(formatMoneyShort(-40)).toBe('$0'); // sub-dollar: no "-$0"
    expect(formatMoneyShort(40)).toBe('$0');
  });
});

describe('formatWeekdayDate', () => {
  it('renders a long weekday + short date in the given timezone', () => {
    expect(formatWeekdayDate('2026-06-20T12:00:00Z', 'UTC')).toBe('Saturday, Jun 20');
  });

  it('returns empty for null/invalid input', () => {
    expect(formatWeekdayDate(null)).toBe('');
    expect(formatWeekdayDate('not-a-date')).toBe('');
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

describe('formatRelativeTime', () => {
  const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  it('renders compact buckets up to a week', () => {
    expect(formatRelativeTime(at(10_000), NOW)).toBe('now'); // < 45s
    expect(formatRelativeTime(at(9 * 60_000), NOW)).toBe('9m');
    expect(formatRelativeTime(at(3 * 3_600_000), NOW)).toBe('3h');
    expect(formatRelativeTime(at(2 * 86_400_000), NOW)).toBe('2d');
  });

  it('falls back to a short date once older than a week', () => {
    expect(formatRelativeTime('2026-06-10T12:00:00Z', NOW, 'UTC')).toBe('Jun 10, 2026');
  });

  it('treats slight clock skew (future) as "now", but a genuine future date as a date', () => {
    expect(formatRelativeTime(at(-5_000), NOW)).toBe('now'); // 5s future → skew
    expect(formatRelativeTime('2026-06-27T12:00:00Z', NOW, 'UTC')).toBe('Jun 27, 2026'); // 3d future
  });

  it('is empty for invalid input', () => {
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
