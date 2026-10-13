/**
 * Free-text service-location states normalised to USPS codes (M4): a Florida
 * address stored as "Florida" or "Fla." must still get Florida's 20:00 close.
 */
import { describe, it, expect } from 'vitest';
import { ALL_US_ZONES, normalizeUsState, placePhone } from '../../src/compliance/us-geography';

describe('normalizeUsState', () => {
  it.each([
    ['FL', 'FL'],
    [' fl ', 'FL'],
    ['Florida', 'FL'],
    ['FLORIDA', 'FL'],
    ['Fla.', 'FL'],
    ['New York', 'NY'],
    ['N.Y.', 'NY'],
    ['W. Va.', 'WV'],
    ['West Virginia', 'WV'],
    ['Washington', 'WA'],
    ['Washington, D.C.', 'DC'],
    ['Okla.', 'OK'],
    ['Md', 'MD'],
    ['puerto rico', 'PR'],
  ])('%j → %s', (input, code) => {
    expect(normalizeUsState(input)).toBe(code);
  });

  it.each(['', '  ', 'Narnia', 'XX', 'Ontario'])('%j is not a US state', (input) => {
    expect(normalizeUsState(input)).toBeNull();
  });
});

describe('placePhone', () => {
  it.each([
    ['+13055550100', 'FL', ['America/New_York', 'America/Chicago']],
    ['(206) 555-0100', 'WA', ['America/Los_Angeles']],
    ['16025550100', 'AZ', ['America/Phoenix', 'America/Denver']],
    ['+19155550100', 'TX', ['America/Chicago', 'America/Denver']],
    ['+17875550100', 'PR', ['America/Puerto_Rico']],
  ])('%s is in %s', (phone, state, zones) => {
    expect(placePhone(phone)).toEqual({ state, zones, placed: true });
  });

  it.each([
    ['+14165550100', ['America/Toronto']],
    ['+17095550100', ['America/St_Johns', 'America/Halifax']],
    ['+16045550100', ['America/Vancouver', 'America/Edmonton']],
    ['+18765550100', ['America/Jamaica']],
    ['+18685550100', ['America/Puerto_Rico']],
  ])('%s (Canada / Caribbean) rings in its own zones', (phone, zones) => {
    expect(placePhone(phone)).toEqual({ state: null, zones, placed: true });
  });

  it.each(['+18005550100', '+18885550100', '+15555550100', '+442071234567', '12345'])(
    '%s cannot be placed, so it could be anywhere in the US',
    (phone) => {
      expect(placePhone(phone)).toEqual({ state: null, zones: ALL_US_ZONES, placed: false });
    },
  );
});
