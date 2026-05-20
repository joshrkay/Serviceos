import { describe, it, expect } from 'vitest';
import { normalizeMobileE164, InvalidPhoneNumberError } from './normalize';

describe('P1-022 normalizeMobileE164', () => {
  it('normalizes (555) 123-4567 to E.164', () => {
    expect(normalizeMobileE164('(555) 123-4567')).toBe('+15551234567');
  });

  it('normalizes 555-123-4567 to E.164', () => {
    expect(normalizeMobileE164('555-123-4567')).toBe('+15551234567');
  });

  it('normalizes 555.123.4567 to E.164', () => {
    expect(normalizeMobileE164('555.123.4567')).toBe('+15551234567');
  });

  it('normalizes bare 5551234567 to E.164', () => {
    expect(normalizeMobileE164('5551234567')).toBe('+15551234567');
  });

  it('normalizes +1-555-123-4567 to E.164', () => {
    expect(normalizeMobileE164('+1-555-123-4567')).toBe('+15551234567');
  });

  it('normalizes 1 (555) 123-4567 (leading country digit) to E.164', () => {
    expect(normalizeMobileE164('1 (555) 123-4567')).toBe('+15551234567');
  });

  it('all common US input formats collapse to the same E.164', () => {
    const forms = ['(555) 123-4567', '555-123-4567', '5551234567', '555.123.4567'];
    const out = forms.map((f) => normalizeMobileE164(f));
    expect(new Set(out)).toEqual(new Set(['+15551234567']));
  });

  it('rejects letters ("abc") with a typed error', () => {
    expect(() => normalizeMobileE164('abc')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects a too-short number ("+1234")', () => {
    expect(() => normalizeMobileE164('+1234')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects empty / whitespace input', () => {
    expect(() => normalizeMobileE164('')).toThrow(InvalidPhoneNumberError);
    expect(() => normalizeMobileE164('   ')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects a number whose area code starts with 0 or 1', () => {
    expect(() => normalizeMobileE164('055-123-4567')).toThrow(InvalidPhoneNumberError);
    expect(() => normalizeMobileE164('155-123-4567')).toThrow(InvalidPhoneNumberError);
  });

  it('rejects a too-long number', () => {
    expect(() => normalizeMobileE164('5551234567890')).toThrow(InvalidPhoneNumberError);
  });

  it('the typed error carries the offending input for diagnostics', () => {
    try {
      normalizeMobileE164('abc');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPhoneNumberError);
      expect((err as InvalidPhoneNumberError).input).toBe('abc');
    }
  });
});
