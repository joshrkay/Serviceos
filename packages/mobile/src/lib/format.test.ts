import { describe, expect, it } from 'vitest';
import {
  deriveDurationSeconds,
  formatDuration,
  formatMoneyCents,
  formatMoneyShort,
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

describe('formatDuration', () => {
  it('renders minutes and seconds or seconds only', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(125)).toBe('2m 5s');
  });
});

describe('deriveDurationSeconds', () => {
  it('prefers server-provided durationSeconds', () => {
    expect(deriveDurationSeconds(90, '2026-06-20T10:00:00Z', '2026-06-20T10:05:00Z')).toBe(90);
  });

  it('derives from startedAt and endedAt when durationSeconds is null', () => {
    expect(
      deriveDurationSeconds(null, '2026-06-20T10:00:00Z', '2026-06-20T10:05:30Z'),
    ).toBe(330);
  });

  it('returns null when timestamps are missing or invalid', () => {
    expect(deriveDurationSeconds(null, '2026-06-20T10:00:00Z', null)).toBeNull();
    expect(deriveDurationSeconds(null, null, '2026-06-20T10:05:00Z')).toBeNull();
    expect(deriveDurationSeconds(null, 'bad', '2026-06-20T10:05:00Z')).toBeNull();
    expect(deriveDurationSeconds(null, '2026-06-20T10:05:00Z', '2026-06-20T10:00:00Z')).toBeNull();
  });
});
