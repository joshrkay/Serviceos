/**
 * WS21a — enrolled voice-approval PIN, hashed at rest.
 *
 * Pins: normalization, tenant-salted HMAC, constant-time verify, wrong-PIN
 * rejection, cross-tenant non-replay, and fail-closed behavior when the
 * candidate/hash/secret is missing.
 */
import { describe, it, expect } from 'vitest';
import {
  isEnrollablePin,
  normalizeEnrollmentPin,
  hashVoiceApprovalPin,
  voiceApprovalPinMatches,
  resolveVoiceApprovalPinSecret,
  MIN_PIN_DIGITS,
  MAX_PIN_DIGITS,
} from '../../src/settings/voice-approval-pin';

const SECRET = 'test-tenant-secret-key';
const TENANT = 't-1';

describe('normalizeEnrollmentPin', () => {
  it('strips spaces, dashes, and other non-digits', () => {
    expect(normalizeEnrollmentPin('4 2 7 1')).toBe('4271');
    expect(normalizeEnrollmentPin('42-71')).toBe('4271');
    expect(normalizeEnrollmentPin('4271')).toBe('4271');
  });
  it('handles null/undefined without throwing', () => {
    expect(normalizeEnrollmentPin(undefined as unknown as string)).toBe('');
  });
});

describe('isEnrollablePin', () => {
  it('accepts 4–6 digit PINs', () => {
    expect(isEnrollablePin('4271')).toBe(true);
    expect(isEnrollablePin('42710')).toBe(true);
    expect(isEnrollablePin('427109')).toBe(true);
    expect(isEnrollablePin('4 2 7 1')).toBe(true);
  });
  it('rejects too-short and too-long', () => {
    expect(isEnrollablePin('427')).toBe(false);
    expect(isEnrollablePin('4271098')).toBe(false);
  });
  it('rejects non-digit content that normalizes below the floor', () => {
    expect(isEnrollablePin('abcd')).toBe(false);
    expect(isEnrollablePin('12ab')).toBe(false); // normalizes to "12"
  });
  it('exposes the 4..6 bounds', () => {
    expect([MIN_PIN_DIGITS, MAX_PIN_DIGITS]).toEqual([4, 6]);
  });
});

describe('hashVoiceApprovalPin', () => {
  it('is deterministic for the same digits/tenant/secret', () => {
    expect(hashVoiceApprovalPin('4271', TENANT, SECRET)).toBe(
      hashVoiceApprovalPin('4271', TENANT, SECRET),
    );
  });
  it('never returns the raw PIN (hashed at rest)', () => {
    const hash = hashVoiceApprovalPin('4271', TENANT, SECRET);
    expect(hash).not.toContain('4271');
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });
  it('is salted per tenant — same PIN, different tenants → different hash', () => {
    expect(hashVoiceApprovalPin('4271', 't-a', SECRET)).not.toBe(
      hashVoiceApprovalPin('4271', 't-b', SECRET),
    );
  });
  it('throws without a secret', () => {
    expect(() => hashVoiceApprovalPin('4271', TENANT, '')).toThrow(/secret/);
  });
});

describe('voiceApprovalPinMatches', () => {
  const hash = hashVoiceApprovalPin('4271', TENANT, SECRET);

  it('matches the correct normalized digits', () => {
    expect(voiceApprovalPinMatches('4271', hash, TENANT, SECRET)).toBe(true);
  });
  it('rejects a wrong PIN', () => {
    expect(voiceApprovalPinMatches('9999', hash, TENANT, SECRET)).toBe(false);
  });
  it('rejects the right PIN under the wrong tenant (no cross-tenant replay)', () => {
    expect(voiceApprovalPinMatches('4271', hash, 't-other', SECRET)).toBe(false);
  });
  it('fail-closed on empty candidate / hash / secret', () => {
    expect(voiceApprovalPinMatches('', hash, TENANT, SECRET)).toBe(false);
    expect(voiceApprovalPinMatches('4271', '', TENANT, SECRET)).toBe(false);
    expect(voiceApprovalPinMatches('4271', hash, TENANT, '')).toBe(false);
  });
  it('fail-closed on a malformed (non-hex) stored hash', () => {
    expect(voiceApprovalPinMatches('4271', 'not-a-hash', TENANT, SECRET)).toBe(false);
  });
});

describe('resolveVoiceApprovalPinSecret', () => {
  it('prefers TENANT_ENCRYPTION_KEY', () => {
    expect(
      resolveVoiceApprovalPinSecret({
        TENANT_ENCRYPTION_KEY: 'enc',
        WEBHOOK_SIGNING_SECRET: 'wh',
      } as NodeJS.ProcessEnv),
    ).toBe('enc');
  });
  it('falls back to WEBHOOK_SIGNING_SECRET', () => {
    expect(
      resolveVoiceApprovalPinSecret({ WEBHOOK_SIGNING_SECRET: 'wh' } as NodeJS.ProcessEnv),
    ).toBe('wh');
  });
  it('returns null when neither is set', () => {
    expect(resolveVoiceApprovalPinSecret({} as NodeJS.ProcessEnv)).toBeNull();
  });
});
