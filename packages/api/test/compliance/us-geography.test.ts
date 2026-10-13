/**
 * Free-text service-location states normalised to USPS codes (M4): a Florida
 * address stored as "Florida" or "Fla." must still get Florida's 20:00 close.
 */
import { describe, it, expect } from 'vitest';
import { normalizeUsState, stateForUsPhone } from '../../src/compliance/us-geography';

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

describe('stateForUsPhone', () => {
  it.each([
    ['+13055550100', 'FL'],
    ['(206) 555-0100', 'WA'],
    ['16025550100', 'AZ'],
    ['+19155550100', 'TX'],
    ['+17875550100', 'PR'],
  ])('%s → %s', (phone, state) => {
    expect(stateForUsPhone(phone)).toBe(state);
  });

  it.each(['+15555550100', '+442071234567', '12345'])('%s has no US area-code state', (phone) => {
    expect(stateForUsPhone(phone)).toBeNull();
  });
});
