import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REMINDER_OFFSETS_HOURS,
  normalizeReminderOffsets,
} from '../../src/settings/settings';

describe('normalizeReminderOffsets (Story 10.2)', () => {
  it('defaults to [24, 2] for non-arrays / empty / all-invalid input (PRD US-340+US-341)', () => {
    expect(normalizeReminderOffsets(undefined)).toEqual([24, 2]);
    expect(normalizeReminderOffsets(null)).toEqual([24, 2]);
    expect(normalizeReminderOffsets('24')).toEqual([24, 2]);
    expect(normalizeReminderOffsets([])).toEqual([24, 2]);
    expect(normalizeReminderOffsets([0, -5, 'x', 9999])).toEqual([24, 2]);
    expect(DEFAULT_REMINDER_OFFSETS_HOURS).toEqual([24, 2]);
  });

  it('dedupes, rounds, clamps to [1,720], and sorts descending', () => {
    expect(normalizeReminderOffsets([2, 24, 24, 2])).toEqual([24, 2]);
    expect(normalizeReminderOffsets([1.4, 2.6])).toEqual([3, 1]);
    expect(normalizeReminderOffsets([24, 800, 0.5])).toEqual([24]); // 800 and 0.5 dropped
  });

  it('caps at 5 entries (largest offsets kept)', () => {
    expect(normalizeReminderOffsets([72, 48, 24, 12, 6, 3, 1])).toEqual([
      72, 48, 24, 12, 6,
    ]);
  });

  it('preserves a single configured offset', () => {
    expect(normalizeReminderOffsets([2])).toEqual([2]);
  });
});
