import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseCallerName, parseRequestedTime } from '../src/modules/ai/providers';

// Tuesday 2026-06-09 16:00 ET (20:00 UTC)
const NOW = new Date('2026-06-09T20:00:00.000Z');

describe('parseRequestedTime', () => {
  it('defaults to tomorrow morning (9am ET)', () => {
    const result = parseRequestedTime('my furnace is leaking, please send someone', NOW);
    expect(result.iso).toBe('2026-06-10T13:00:00.000Z');
    expect(result.label).toBe('tomorrow morning');
  });

  it('parses tomorrow afternoon', () => {
    const result = parseRequestedTime('can someone come tomorrow afternoon?', NOW);
    expect(result.iso).toBe('2026-06-10T17:00:00.000Z');
    expect(result.label).toBe('tomorrow afternoon');
  });

  it('parses today with explicit clock time', () => {
    const result = parseRequestedTime('I need someone today at 3pm', NOW);
    expect(result.iso).toBe('2026-06-09T19:00:00.000Z');
    expect(result.label).toBe('today 3pm');
  });

  it('parses weekday names as the next occurrence', () => {
    // NOW is a Tuesday (ET); Friday is +3 days.
    const result = parseRequestedTime('could you come Friday morning?', NOW);
    expect(result.iso).toBe('2026-06-12T13:00:00.000Z');
    expect(result.label).toBe('Friday morning');
  });

  it('a weekday matching today rolls to next week', () => {
    const result = parseRequestedTime('how about Tuesday?', NOW);
    expect(result.iso).toBe('2026-06-16T13:00:00.000Z');
  });

  it('parses minutes and evening phrasing', () => {
    expect(parseRequestedTime('tomorrow around 10:30 am', NOW).iso).toBe('2026-06-10T14:30:00.000Z');
    expect(parseRequestedTime('tonight if possible', NOW).iso).toBe('2026-06-10T21:00:00.000Z');
    expect(parseRequestedTime('tomorrow evening', NOW).iso).toBe('2026-06-10T21:00:00.000Z');
    expect(parseRequestedTime('at noon tomorrow', NOW).iso).toBe('2026-06-10T16:00:00.000Z');
  });

  it('never throws and always returns a valid ISO timestamp (fuzzed)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (message) => {
        const result = parseRequestedTime(message, NOW);
        expect(Number.isNaN(new Date(result.iso).getTime())).toBe(false);
        expect(result.label.length).toBeGreaterThan(0);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('parseCallerName', () => {
  it('extracts introduced names', () => {
    expect(parseCallerName('Hi, this is Janet Miller. My furnace is leaking.')).toBe('Janet Miller');
    expect(parseCallerName('Hello, my name is Frank Castle Junior, no hot water')).toBe(
      'Frank Castle Junior',
    );
  });

  it('returns null when nobody introduces themselves', () => {
    expect(parseCallerName('my ac is broken and the house is hot')).toBeNull();
    expect(parseCallerName('this is urgent, please call back')).toBeNull();
  });
});
