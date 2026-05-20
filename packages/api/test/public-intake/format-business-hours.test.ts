import { describe, it, expect } from 'vitest';
import { formatBusinessHoursSummary } from '../../src/public-intake/format-business-hours';

describe('formatBusinessHoursSummary', () => {
  it('returns null when hours are empty', () => {
    expect(formatBusinessHoursSummary({}, 'America/Chicago')).toBeNull();
  });

  it('formats a uniform Mon–Fri range', () => {
    const summary = formatBusinessHoursSummary(
      {
        mon: { open: '08:00', close: '17:00' },
        tue: { open: '08:00', close: '17:00' },
        wed: { open: '08:00', close: '17:00' },
        thu: { open: '08:00', close: '17:00' },
        fri: { open: '08:00', close: '17:00' },
        sat: null,
        sun: null,
      },
      'America/Chicago',
    );
    expect(summary).toContain('Mon–Fri');
    expect(summary).toContain('8 AM');
    expect(summary).toContain('5 PM');
  });
});
