import { describe, expect, it } from 'vitest';
import { normalizeCallbackNumber, isValidCallbackNumber } from './callbackNumber';

describe('normalizeCallbackNumber', () => {
  it('prefixes a bare 10-digit US number with +1', () => {
    expect(normalizeCallbackNumber('555 123 4567')).toBe('+15551234567');
    expect(normalizeCallbackNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('keeps an already-E.164 number, including short (10-digit) country formats', () => {
    expect(normalizeCallbackNumber('+15551234567')).toBe('+15551234567');
    expect(normalizeCallbackNumber('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizeCallbackNumber('+47 123 45 678')).toBe('+4712345678'); // 10 digits, valid
  });

  it('treats an 11-digit US number (leading 1) as E.164', () => {
    expect(normalizeCallbackNumber('15551234567')).toBe('+15551234567');
  });

  it('rejects a no-plus 11-digit non-US number instead of guessing +0…', () => {
    // UK mobile typed without +; must not become "+07911123456".
    expect(normalizeCallbackNumber('07911 123456')).toBeNull();
    expect(normalizeCallbackNumber('25551234567')).toBeNull();
  });

  it('rejects a +-prefixed number that is too short or starts with 0', () => {
    expect(normalizeCallbackNumber('+123456789')).toBeNull(); // 9 digits — below the E.164 floor
    expect(normalizeCallbackNumber('+0123456789')).toBeNull(); // country code can't start with 0
  });

  it('rejects too-short / empty / junk input', () => {
    expect(normalizeCallbackNumber('')).toBeNull();
    expect(normalizeCallbackNumber(null)).toBeNull();
    expect(normalizeCallbackNumber('12345')).toBeNull();
    expect(normalizeCallbackNumber('+123')).toBeNull();
  });

  it('isValidCallbackNumber mirrors normalize', () => {
    expect(isValidCallbackNumber('5551234567')).toBe(true);
    expect(isValidCallbackNumber('nope')).toBe(false);
  });
});
