import { describe, expect, it } from 'vitest';
import {
  addDaysToDate,
  formatDayHeading,
  formatSlotTime,
  groupSlotsByDay,
  slotDayKey,
} from './slots';

const TZ = 'America/New_York';

describe('slotDayKey', () => {
  it('returns the tenant-zone calendar day for an instant', () => {
    // 18:00Z on Jul 23 is 2:00 PM EDT the same day.
    expect(slotDayKey('2026-07-23T18:00:00Z', TZ)).toBe('2026-07-23');
  });

  it('rolls back across midnight in the tenant zone', () => {
    // 02:00Z on Jul 24 is 10:00 PM EDT on Jul 23.
    expect(slotDayKey('2026-07-24T02:00:00Z', TZ)).toBe('2026-07-23');
  });

  it('returns empty string for an invalid instant', () => {
    expect(slotDayKey('not-a-date', TZ)).toBe('');
  });
});

describe('formatSlotTime', () => {
  it('renders wall-clock start time in the tenant zone', () => {
    expect(formatSlotTime('2026-07-23T18:00:00Z', TZ)).toBe('2:00 PM');
  });
});

describe('formatDayHeading', () => {
  it('renders weekday + short date in the tenant zone', () => {
    expect(formatDayHeading('2026-07-23T18:00:00Z', TZ)).toBe('Thu, Jul 23');
  });
});

describe('groupSlotsByDay', () => {
  it('groups slots into tenant-zone days in order, labeling each', () => {
    const days = groupSlotsByDay(
      [
        { start: '2026-07-23T18:00:00Z', end: '2026-07-23T19:00:00Z' },
        { start: '2026-07-23T19:00:00Z', end: '2026-07-23T20:00:00Z' },
        { start: '2026-07-24T14:00:00Z', end: '2026-07-24T15:00:00Z' },
      ],
      TZ,
    );

    expect(days.map((d) => d.dayKey)).toEqual(['2026-07-23', '2026-07-24']);
    expect(days[0].heading).toBe('Thu, Jul 23');
    expect(days[0].slots.map((s) => s.label)).toEqual(['2:00 PM', '3:00 PM']);
    expect(days[1].slots.map((s) => s.label)).toEqual(['10:00 AM']);
  });

  it('skips invalid instants', () => {
    const days = groupSlotsByDay(
      [{ start: 'bad', end: 'bad' }, { start: '2026-07-23T18:00:00Z', end: '2026-07-23T19:00:00Z' }],
      TZ,
    );
    expect(days).toHaveLength(1);
    expect(days[0].dayKey).toBe('2026-07-23');
  });
});

describe('addDaysToDate', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDaysToDate('2026-07-23', 14)).toBe('2026-08-06');
    expect(addDaysToDate('2026-12-25', 10)).toBe('2027-01-04');
    expect(addDaysToDate('2026-07-23', 0)).toBe('2026-07-23');
  });
});
