import { describe, it, expect } from 'vitest';
import { timeLabelTo24h } from './NewJobFlow';

describe('timeLabelTo24h', () => {
  it('maps whole-hour chip labels', () => {
    expect(timeLabelTo24h('8:00 AM')).toBe('08:00');
    expect(timeLabelTo24h('2:00 PM')).toBe('14:00');
  });

  it('parses off-chip voice-parsed times to HH:mm (the silent-unscheduled fix)', () => {
    expect(timeLabelTo24h('2:30 PM')).toBe('14:30');
    expect(timeLabelTo24h('2:30 pm')).toBe('14:30');
    expect(timeLabelTo24h('7:45 AM')).toBe('07:45');
    expect(timeLabelTo24h('9 am')).toBe('09:00');
  });

  it('handles 12 AM/PM edge cases', () => {
    expect(timeLabelTo24h('12:00 AM')).toBe('00:00'); // midnight
    expect(timeLabelTo24h('12:15 PM')).toBe('12:15'); // noon
  });

  it('accepts already-24h labels', () => {
    expect(timeLabelTo24h('14:30')).toBe('14:30');
    expect(timeLabelTo24h('00:05')).toBe('00:05');
  });

  it('returns null for unparseable or out-of-range labels', () => {
    expect(timeLabelTo24h('')).toBeNull();
    expect(timeLabelTo24h('lunchtime')).toBeNull();
    expect(timeLabelTo24h('25:00')).toBeNull();
    expect(timeLabelTo24h('9:75 AM')).toBeNull();
  });
});
