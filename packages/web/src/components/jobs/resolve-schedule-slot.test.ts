import { describe, it, expect } from 'vitest';
import { resolveScheduleSlot } from './resolve-schedule-slot';

// A fixed local-noon "now" keeps date math deterministic regardless of the
// runner's clock (but still subject to its timezone, which is fine: the helper
// is browser-local by design).
const NOW = new Date(2026, 5, 30, 9, 0, 0); // 2026-06-30 09:00 local

describe('resolveScheduleSlot', () => {
  it('resolves Today + a time to a one-hour instant range', () => {
    const slot = resolveScheduleSlot('Today', '2:00 PM', NOW);
    expect(slot).not.toBeNull();
    const start = new Date(slot!.scheduledStart);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(5);
    expect(start.getDate()).toBe(30);
    expect(start.getHours()).toBe(14);
    expect(start.getMinutes()).toBe(0);
    // Default 60-minute duration.
    expect(new Date(slot!.scheduledEnd).getTime() - start.getTime()).toBe(60 * 60_000);
  });

  it('resolves Tomorrow to the next calendar day', () => {
    const slot = resolveScheduleSlot('Tomorrow', '8:00 AM', NOW);
    const start = new Date(slot!.scheduledStart);
    expect(start.getDate()).toBe(1); // rolls 06-30 -> 07-01
    expect(start.getMonth()).toBe(6);
    expect(start.getHours()).toBe(8);
  });

  it('resolves a real ISO date from the custom date input', () => {
    const slot = resolveScheduleSlot('2026-08-15', '10:00 AM', NOW);
    const start = new Date(slot!.scheduledStart);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(7);
    expect(start.getDate()).toBe(15);
    expect(start.getHours()).toBe(10);
  });

  it('handles 12-hour boundaries (12 PM = noon, 12 AM = midnight)', () => {
    expect(new Date(resolveScheduleSlot('Today', '12:00 PM', NOW)!.scheduledStart).getHours()).toBe(12);
    expect(new Date(resolveScheduleSlot('Today', '12:00 AM', NOW)!.scheduledStart).getHours()).toBe(0);
  });

  it('honors a custom duration', () => {
    const slot = resolveScheduleSlot('Today', '9:00 AM', NOW, 90);
    expect(
      new Date(slot!.scheduledEnd).getTime() - new Date(slot!.scheduledStart).getTime(),
    ).toBe(90 * 60_000);
  });

  it('returns null when no time is selected', () => {
    expect(resolveScheduleSlot('Today', '', NOW)).toBeNull();
  });

  it('returns null when no date is selected', () => {
    expect(resolveScheduleSlot('', '2:00 PM', NOW)).toBeNull();
  });

  it('returns null for placeholder/demo date labels (no real calendar date)', () => {
    expect(resolveScheduleSlot('Tue Mar 11', '2:00 PM', NOW)).toBeNull();
    expect(resolveScheduleSlot('Custom', '2:00 PM', NOW)).toBeNull();
    expect(resolveScheduleSlot('__custom', '2:00 PM', NOW)).toBeNull();
  });

  it('returns null for a malformed time', () => {
    expect(resolveScheduleSlot('Today', '25:00 PM', NOW)).toBeNull();
    expect(resolveScheduleSlot('Today', 'noon', NOW)).toBeNull();
  });
});
