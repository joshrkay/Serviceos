import { describe, it, expect } from 'vitest';
import { isTwilioTestNumber } from '../../src/telephony/phone-policy';

// #880 — the predicate every read/write site uses to keep Twilio magic test
// numbers (the fictitious +1 (500) 555-xxxx block) from ever being surfaced
// publicly, claimed via the picker, or persisted as a tenant's real line.
describe('isTwilioTestNumber', () => {
  it('flags the dev-stub magic number +15005550006', () => {
    expect(isTwilioTestNumber('+15005550006')).toBe(true);
  });

  it('flags the whole +1500555xxxx magic block', () => {
    expect(isTwilioTestNumber('+15005550000')).toBe(true); // "unavailable"
    expect(isTwilioTestNumber('+15005550001')).toBe(true); // "invalid"
    expect(isTwilioTestNumber('+15005550009')).toBe(true);
    expect(isTwilioTestNumber('+15005559999')).toBe(true);
  });

  it('tolerates surrounding whitespace (stored values are trimmed defensively)', () => {
    expect(isTwilioTestNumber('  +15005550006  ')).toBe(true);
  });

  it('does not flag real NANP numbers', () => {
    expect(isTwilioTestNumber('+15125550100')).toBe(false);
    expect(isTwilioTestNumber('+12125551234')).toBe(false);
    // Area code 500 with a non-555 exchange is not the magic block.
    expect(isTwilioTestNumber('+15005440006')).toBe(false);
    // 555 exchange under a different area code is a legitimate assignment.
    expect(isTwilioTestNumber('+15125550006')).toBe(false);
  });

  it('does not flag non-E.164 or non-NANP shapes', () => {
    expect(isTwilioTestNumber('5005550006')).toBe(false);
    expect(isTwilioTestNumber('(500) 555-0006')).toBe(false);
    expect(isTwilioTestNumber('+445005550006')).toBe(false);
    expect(isTwilioTestNumber('')).toBe(false);
  });
});
