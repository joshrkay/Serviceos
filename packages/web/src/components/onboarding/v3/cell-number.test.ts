/**
 * The cases mirror packages/api/test/shared/phone/normalize.test.ts, the API's own
 * table for normalizeMobileE164, plus the shapes the review found slipping past a
 * "ten digits somewhere" check: twelve digits, +44, and an area code starting 0.
 */
import { describe, expect, it } from 'vitest';
import { isUsCellNumber } from './cell-number';

describe('isUsCellNumber', () => {
  it.each([
    '(555) 123-4567',
    '555-123-4567',
    '555.123.4567',
    '5551234567',
    '+1-555-123-4567',
    '1 (555) 123-4567',
    '+1 (216) 555-0100',
    '+12165550100',
    '+1 216 555 0100',
    '216-555-0100',
    '1 (216) 555-0100',
    '(216) 555-0100',
    '216.555.0100',
    '2165550100',
    '12165550100',
    '  (216) 555-0100  ',
  ])('accepts the US form %j', (raw) => {
    expect(isUsCellNumber(raw)).toBe(true);
  });

  it.each([
    // A leading "+" announces a country code, and only +1 is ours (never read as a bare US number).
    '+47 912 34 567',
    '+4791234567',
    '+5551234567',
    '+44 7911 123456',
    '+44 7911 123 456',
    // "+1" with only ten digits: the 1 would be its area code.
    '+1555123456',
    '+1 (555) 123-456',
    // Letters and other characters that are not part of a typed number.
    'abc',
    'call me later',
    '216-555-CALL',
    '216 555 0100 ext 5',
    '216-555-0100 x5',
    // Wrong length.
    '+1234',
    '216',
    '555123456',
    '5551234567890',
    '216555010012',
    '22165550100',
    // Area code starting 0 or 1 is not a NANP number.
    '055-123-4567',
    '155-123-4567',
    '(055) 123-4567',
    '1 (055) 123-4567',
    '+1 (155) 123-4567',
    // Nothing at all.
    '',
    '   ',
  ])('rejects %j', (raw) => {
    expect(isUsCellNumber(raw)).toBe(false);
  });
});
