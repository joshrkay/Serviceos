import { describe, it, expect } from 'vitest';
import {
  resolveUsageWindow,
  toSafeInteger,
  MAX_USAGE_WINDOW_DAYS,
} from '../../src/admin/tenant-usage';
import { ValidationError } from '../../src/shared/errors';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const DAY_MS = 86_400_000;

describe('resolveUsageWindow', () => {
  it('defaults to [now - 30d, now) when nothing is given', () => {
    expect(resolveUsageWindow({}, NOW)).toEqual({
      from: new Date(NOW.getTime() - 30 * DAY_MS),
      to: NOW,
    });
    expect(resolveUsageWindow(undefined, NOW).to).toEqual(NOW);
  });

  it('anchors the default from on an explicit to', () => {
    const w = resolveUsageWindow({ to: '2026-06-30T00:00:00Z' }, NOW);
    expect(w.from.toISOString()).toBe('2026-05-31T00:00:00.000Z');
  });

  it('normalizes offsets to UTC instants', () => {
    const w = resolveUsageWindow(
      { from: '2026-09-01T00:00:00+02:00', to: '2026-09-02' },
      NOW,
    );
    expect(w.from.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('accepts exactly the maximum window', () => {
    const from = new Date('2025-01-01T00:00:00Z');
    const to = new Date(from.getTime() + MAX_USAGE_WINDOW_DAYS * DAY_MS);
    expect(() =>
      resolveUsageWindow({ from: from.toISOString(), to: to.toISOString() }, NOW),
    ).not.toThrow();
  });

  it.each([
    [{ from: 'not-a-date' }],
    [{ to: '2026-13-01' }],
    [{ from: ['2026-01-01'] }],
    [{ from: '2026-10-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    [{ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    [{ from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:01Z' }],
  ])('rejects %j with a ValidationError', (query) => {
    expect(() => resolveUsageWindow(query, NOW)).toThrow(ValidationError);
  });
});

describe('toSafeInteger', () => {
  it('maps pg aggregate text and nulls to integers', () => {
    expect(toSafeInteger('0')).toBe(0);
    expect(toSafeInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeInteger(42)).toBe(42);
    expect(toSafeInteger(null)).toBe(0);
    expect(toSafeInteger(undefined)).toBe(0);
  });

  it('refuses values that would lose precision or are not integers', () => {
    expect(() => toSafeInteger('9007199254740993')).toThrow();
    expect(() => toSafeInteger('1.5')).toThrow();
    expect(() => toSafeInteger('abc')).toThrow();
  });
});
