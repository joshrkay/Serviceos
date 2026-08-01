import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  formatSlotDayLabel,
  formatSlotTimeRange,
  groupSlotsByDay,
  slotDayKey,
} from './slotPicker';

describe('slotDayKey', () => {
  it('buckets an instant into the tenant-local day, not the UTC day', () => {
    // 2026-06-22T02:00:00Z is still Jun 21 in America/New_York (UTC-4).
    expect(slotDayKey('2026-06-22T02:00:00Z', 'America/New_York')).toBe('2026-06-21');
    expect(slotDayKey('2026-06-22T02:00:00Z', 'UTC')).toBe('2026-06-22');
  });

  it('returns "" for an invalid instant', () => {
    expect(slotDayKey('not-a-date')).toBe('');
  });
});

describe('formatSlotTimeRange', () => {
  it('renders the time window in the tenant timezone', () => {
    // 13:00–14:00 UTC is 9:00–10:00 AM in America/New_York.
    expect(
      formatSlotTimeRange({ start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }, 'America/New_York'),
    ).toBe('9:00 AM – 10:00 AM');
  });
});

describe('formatSlotDayLabel', () => {
  it('renders weekday + short date in the tenant timezone', () => {
    // Still Jun 21 (Sunday) in NY for a 02:00Z instant.
    expect(formatSlotDayLabel('2026-06-22T02:00:00Z', 'America/New_York')).toBe('Sun, Jun 21');
  });
});

describe('groupSlotsByDay', () => {
  it('groups chronologically by tenant-local day', () => {
    const slots = [
      { start: '2026-06-22T12:00:00Z', end: '2026-06-22T13:00:00Z' },
      { start: '2026-06-22T14:00:00Z', end: '2026-06-22T15:00:00Z' },
      { start: '2026-06-23T12:00:00Z', end: '2026-06-23T13:00:00Z' },
    ];
    const groups = groupSlotsByDay(slots, 'UTC');
    expect(groups.map((g) => g.dayKey)).toEqual(['2026-06-22', '2026-06-23']);
    expect(groups[0].slots).toHaveLength(2);
    expect(groups[1].slots).toHaveLength(1);
  });

  it('skips slots with an invalid start', () => {
    const groups = groupSlotsByDay([{ start: 'bad', end: 'bad' }], 'UTC');
    expect(groups).toHaveLength(0);
  });
});

describe('addDaysYmd', () => {
  it('adds calendar days across a month boundary', () => {
    expect(addDaysYmd('2026-06-20', 14)).toBe('2026-07-04');
  });

  it('returns the input unchanged for a malformed date', () => {
    expect(addDaysYmd('nope', 5)).toBe('nope');
  });
});
