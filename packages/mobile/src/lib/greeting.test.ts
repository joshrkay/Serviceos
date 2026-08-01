import { describe, expect, it } from 'vitest';
import { greetingForDate } from './greeting';

describe('greetingForDate', () => {
  it('greets by time of day in the given timezone', () => {
    expect(greetingForDate(new Date('2026-06-20T09:00:00Z'), 'UTC')).toBe('Good morning');
    expect(greetingForDate(new Date('2026-06-20T14:00:00Z'), 'UTC')).toBe('Good afternoon');
    expect(greetingForDate(new Date('2026-06-20T20:00:00Z'), 'UTC')).toBe('Good evening');
  });

  it('reads the hour in the tenant timezone, not UTC', () => {
    // 02:00 UTC is 22:00 (previous evening) in New York — evening, not night/morning.
    expect(greetingForDate(new Date('2026-06-20T02:00:00Z'), 'America/New_York')).toBe(
      'Good evening',
    );
    // 16:00 UTC is 12:00 noon in New York — afternoon.
    expect(greetingForDate(new Date('2026-06-20T16:00:00Z'), 'America/New_York')).toBe(
      'Good afternoon',
    );
  });

  it('treats the 11:59→12:00 boundary as the start of afternoon', () => {
    expect(greetingForDate(new Date('2026-06-20T11:59:00Z'), 'UTC')).toBe('Good morning');
    expect(greetingForDate(new Date('2026-06-20T12:00:00Z'), 'UTC')).toBe('Good afternoon');
  });
});
