/**
 * Task 10 (2026-08-07 tradesperson plan) quality-review I2/I3/I6 —
 * spoken-format.ts shared helper tests.
 * `formatHours`, `formatTime`, `technicianDisplayName`, and `spokenList`
 * were consolidated here from three-plus duplicated copies across the
 * lookup-skill family; this file is their first direct test coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  formatHours,
  formatTime,
  technicianDisplayName,
  spokenList,
} from '../../../src/ai/skills/spoken-format';

describe('formatHours', () => {
  it('singular: exactly 1 hour reads "1 hour", not "1 hours"', () => {
    expect(formatHours(1)).toBe('1 hour');
  });

  it('plural whole hours: "8 hours"', () => {
    expect(formatHours(8)).toBe('8 hours');
  });

  it('zero hours: "0 hours"', () => {
    expect(formatHours(0)).toBe('0 hours');
  });

  it('fractional hours round to one decimal: "12.5 hours"', () => {
    expect(formatHours(12.5)).toBe('12.5 hours');
  });

  it('a 2-decimal input (e.g. from weeklyHoursByUser rounding) collapses to 1 decimal', () => {
    // The exact I4 mismatch this consolidation closes: the card used to
    // speak "7.83 hrs" while the summary spoke "7.8 hours".
    expect(formatHours(7.83)).toBe('7.8 hours');
  });

  it('an integer-valued fractional (e.g. 4.0) drops the trailing .0', () => {
    expect(formatHours(4.0)).toBe('4 hours');
  });
});

describe('formatTime', () => {
  it('drops a bare-hour ":00" so "1:00 PM" speaks as "1 PM"', () => {
    // 2026-06-11T17:00:00Z = 1:00 PM America/New_York (EDT, UTC-4).
    expect(formatTime(new Date('2026-06-11T17:00:00.000Z'), 'America/New_York')).toBe('1 PM');
  });

  it('keeps a non-zero minute', () => {
    expect(formatTime(new Date('2026-06-11T17:30:00.000Z'), 'America/New_York')).toBe('1:30 PM');
  });

  it('renders in the given timezone, not the server default', () => {
    // Same instant, two zones — 1pm ET is 10am PT.
    const instant = new Date('2026-06-11T17:00:00.000Z');
    expect(formatTime(instant, 'America/New_York')).toBe('1 PM');
    expect(formatTime(instant, 'America/Los_Angeles')).toBe('10 AM');
  });
});

describe('technicianDisplayName', () => {
  it('joins first + last name', () => {
    expect(technicianDisplayName({ firstName: 'Mike', lastName: 'Diaz', email: 'm@x.com' })).toBe(
      'Mike Diaz',
    );
  });

  it('falls back to email when both names are absent', () => {
    expect(technicianDisplayName({ email: 'invited@x.com' })).toBe('invited@x.com');
  });

  it('uses whichever single name is present', () => {
    expect(technicianDisplayName({ firstName: 'Mike', email: 'm@x.com' })).toBe('Mike');
    expect(technicianDisplayName({ lastName: 'Diaz', email: 'm@x.com' })).toBe('Diaz');
  });
});

describe('spokenList', () => {
  it('empty list → empty string', () => {
    expect(spokenList([])).toBe('');
  });

  it('one item → the item itself, no conjunction', () => {
    expect(spokenList(['Mike'])).toBe('Mike');
  });

  it('two items → "A and B"', () => {
    expect(spokenList(['Mike', 'Carlos'])).toBe('Mike and Carlos');
  });

  it('three or more items → "A, B and C" (no Oxford comma, matches lookup-job-profit precedent)', () => {
    expect(spokenList(['Mike', 'Carlos', 'Dana'])).toBe('Mike, Carlos and Dana');
  });

  it('a truncation tail is just another list item — "and N more" falls out for free', () => {
    expect(spokenList(['Mike', 'Carlos', 'Dana', '5 more'])).toBe('Mike, Carlos, Dana and 5 more');
  });
});
