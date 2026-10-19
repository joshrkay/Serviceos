/**
 * S6-3 (U7) — the demo call's platform Twilio credentials: only the explicit
 * PLATFORM_TWILIO_* names, null when any is missing or blank, and never the
 * tenant/global TWILIO_* fallback (docs/solutions/logic-errors/
 * click-to-call-gate-requires-global-twilio-sid.md).
 */
import { describe, it, expect } from 'vitest';
import { getPlatformTwilioCreds } from '../../src/integrations/credentials';

const FULL = {
  PLATFORM_TWILIO_ACCOUNT_SID: 'ACplatform',
  PLATFORM_TWILIO_AUTH_TOKEN: 'platform-token',
  PLATFORM_TWILIO_FROM_NUMBER: '+15125550100',
};

describe('getPlatformTwilioCreds', () => {
  it('reads the three platform names', () => {
    expect(getPlatformTwilioCreds(FULL)).toEqual({
      accountSid: 'ACplatform',
      authToken: 'platform-token',
      fromE164: '+15125550100',
    });
  });

  it.each(Object.keys(FULL))('is null when %s is missing or blank', (name) => {
    const missing: Record<string, string | undefined> = { ...FULL };
    delete missing[name];
    expect(getPlatformTwilioCreds(missing)).toBeNull();
    expect(getPlatformTwilioCreds({ ...FULL, [name]: '   ' })).toBeNull();
  });

  it('never falls through to the global TWILIO_* names', () => {
    expect(
      getPlatformTwilioCreds({
        TWILIO_ACCOUNT_SID: 'ACglobal',
        TWILIO_AUTH_TOKEN: 'global-token',
        TWILIO_FROM_NUMBER: '+15125550199',
      }),
    ).toBeNull();
    expect(
      getPlatformTwilioCreds({ ...FULL, PLATFORM_TWILIO_AUTH_TOKEN: undefined, TWILIO_AUTH_TOKEN: 'global-token' }),
    ).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(getPlatformTwilioCreds({ ...FULL, PLATFORM_TWILIO_FROM_NUMBER: ' +15125550100\n' })?.fromE164).toBe(
      '+15125550100',
    );
  });
});
