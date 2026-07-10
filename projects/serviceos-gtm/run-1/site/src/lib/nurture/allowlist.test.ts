import { describe, it, expect } from 'vitest';
import { TEST_CONTACT_ALLOWLIST, GO_LIVE_UNLOCK, isAllowedTestContact, checkSendGate } from './allowlist';

describe('nurture allowlist gate', () => {
  it('GO_LIVE_UNLOCK is false (must stay false outside a deliberate go-live commit)', () => {
    expect(GO_LIVE_UNLOCK).toBe(false);
  });

  it('lists exactly the 3 test contacts', () => {
    expect(TEST_CONTACT_ALLOWLIST).toEqual([
      'test+rivet@example.com',
      'test+mike@example.com',
      'test+jenna@example.com',
    ]);
  });

  it('allows every allowlisted test contact', () => {
    for (const address of TEST_CONTACT_ALLOWLIST) {
      expect(isAllowedTestContact(address)).toBe(true);
    }
  });

  it('is case-insensitive on the allowlist match', () => {
    expect(isAllowedTestContact('TEST+RIVET@EXAMPLE.COM')).toBe(true);
  });

  it('blocks a real-looking address', () => {
    expect(isAllowedTestContact('real.customer@acmehvac.com')).toBe(false);
  });

  it('blocks undefined/null/empty email', () => {
    expect(isAllowedTestContact(undefined)).toBe(false);
    expect(isAllowedTestContact(null)).toBe(false);
    expect(isAllowedTestContact('')).toBe(false);
  });

  it('checkSendGate blocks a real address with the required shape', () => {
    const result = checkSendGate('real.customer@acmehvac.com');
    expect(result).toMatchObject({ allowed: false, blocked: true, reason: 'not a test contact' });
  });

  it('checkSendGate allows a test address', () => {
    const result = checkSendGate('test+jenna@example.com');
    expect(result).toMatchObject({ allowed: true, blocked: false });
  });
});
