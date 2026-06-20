import { describe, expect, it } from 'vitest';
import { normalizeCallbackNumber, isValidCallbackNumber } from './callbackNumber';

describe('normalizeCallbackNumber', () => {
  it('prefixes a bare 10-digit US number with +1', () => {
    expect(normalizeCallbackNumber('555 123 4567')).toBe('+15551234567');
    expect(normalizeCallbackNumber('(555) 123-4567')).toBe('+15551234567');
  });

  it('keeps an already-E.164 number', () => {
    expect(normalizeCallbackNumber('+15551234567')).toBe('+15551234567');
    expect(normalizeCallbackNumber('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('treats an 11-digit national number as E.164', () => {
    expect(normalizeCallbackNumber('15551234567')).toBe('+15551234567');
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
