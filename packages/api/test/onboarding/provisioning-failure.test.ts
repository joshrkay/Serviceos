import { describe, it, expect } from 'vitest';
import {
  PROVISIONING_FAILURE_CODES,
  PROVISIONING_FAILURE_MESSAGES,
  classifyProvisioningFailure,
} from '../../src/onboarding/provisioning-failure';

/**
 * Every `last_error` text the Twilio provisioning worker records, built by the
 * same builders the worker and the Twilio helpers call. The literal right-hand
 * side is the wording as it stood before the builders existed (byte for byte),
 * so a reworded builder fails here instead of quietly classifying `unknown`.
 */
const BUILT: Array<{ name: keyof typeof PROVISIONING_FAILURE_MESSAGES; text: string; literal: string; code: string }> = [
  {
    name: 'selectedNumberUnavailable',
    text: PROVISIONING_FAILURE_MESSAGES.selectedNumberUnavailable('+12165550123'),
    literal: 'Selected number +12165550123 is no longer available — please choose another',
    code: 'area_code_unavailable',
  },
  {
    name: 'noInventory',
    text: PROVISIONING_FAILURE_MESSAGES.noInventory('OH'),
    literal: 'No available US phone numbers found for region OH',
    code: 'area_code_unavailable',
  },
  {
    name: 'noInventory',
    text: PROVISIONING_FAILURE_MESSAGES.noInventory(undefined),
    literal: 'No available US phone numbers found for region any',
    code: 'area_code_unavailable',
  },
  {
    name: 'twilioCredentialsUnset',
    text: PROVISIONING_FAILURE_MESSAGES.twilioCredentialsUnset(),
    literal: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set',
    code: 'credentials_missing',
  },
  {
    name: 'encryptionKeyUnset',
    text: PROVISIONING_FAILURE_MESSAGES.encryptionKeyUnset(),
    literal: 'TENANT_ENCRYPTION_KEY must be set',
    code: 'credentials_missing',
  },
  {
    name: 'testCredentials',
    text: PROVISIONING_FAILURE_MESSAGES.testCredentials('+15005550006'),
    literal:
      'Refusing to persist Twilio test number +15005550006 as the tenant line — ' +
      'the configured Twilio credentials appear to be TEST credentials; ' +
      'fix TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and re-run provisioning',
    code: 'credentials_missing',
  },
  {
    name: 'twilioHttp',
    text: PROVISIONING_FAILURE_MESSAGES.twilioHttp('POST', 'https://api.twilio.com/2010-04-01/Accounts.json', 503, 'Service Unavailable'),
    literal: 'Twilio POST https://api.twilio.com/2010-04-01/Accounts.json → 503: Service Unavailable',
    code: 'provider_error',
  },
  {
    name: 'twilioHttp',
    text: PROVISIONING_FAILURE_MESSAGES.twilioHttp('GET', 'https://api.twilio.com/2010-04-01/Accounts/AC1/AvailablePhoneNumbers/US/Local.json?Limit=1', 500, '{"code":20500,\n"message":"Internal"}'),
    literal: 'Twilio GET https://api.twilio.com/2010-04-01/Accounts/AC1/AvailablePhoneNumbers/US/Local.json?Limit=1 → 500: {"code":20500,\n"message":"Internal"}',
    code: 'provider_error',
  },
  {
    name: 'twilioHttp',
    text: PROVISIONING_FAILURE_MESSAGES.twilioHttp('DELETE', 'https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers/PN1.json', 502, ''),
    literal: 'Twilio DELETE https://api.twilio.com/2010-04-01/Accounts/AC1/IncomingPhoneNumbers/PN1.json → 502: ',
    code: 'provider_error',
  },
  {
    name: 'didAlreadyClaimedReleased',
    text: PROVISIONING_FAILURE_MESSAGES.didAlreadyClaimedReleased('+12165550123'),
    literal:
      'Phone number +12165550123 is already assigned to another tenant — ' +
      'a DID can serve only one tenant (inbound routing resolves the tenant ' +
      'from the number). The number just purchased for this tenant has been released, ' +
      'so nothing is being billed for it. Release the number from the other ' +
      'tenant, or provision this tenant on a different number, then re-run ' +
      'provisioning.',
    code: 'unknown',
  },
  {
    // The release-failure variant embeds a Twilio DELETE HTTP text: it must
    // still classify as the conflict (unknown), never as provider_error.
    name: 'didAlreadyClaimedNotReleased',
    text: PROVISIONING_FAILURE_MESSAGES.didAlreadyClaimedNotReleased(
      '+12165550123',
      'Twilio DELETE https://api.twilio.com/x → 503: down',
      'PN123',
      'AC456',
    ),
    literal:
      'Phone number +12165550123 is already assigned to another tenant — ' +
      'a DID can serve only one tenant (inbound routing resolves the tenant ' +
      'from the number). Releasing the number just purchased for this tenant FAILED ' +
      '(Twilio DELETE https://api.twilio.com/x → 503: down) — release PN123 from subaccount ' +
      'AC456 by hand, or the next provisioning run will recover it ' +
      'and hit this same conflict.',
    code: 'unknown',
  },
];

describe('provisioning failure messages', () => {
  it.each(BUILT.map((b) => [b.name, b] as const))('%s builds the wording the worker has always recorded', (_name, b) => {
    expect(b.text).toBe(b.literal);
  });

  it('every builder is covered above (a new builder needs its own classification case)', () => {
    expect(new Set(BUILT.map((b) => b.name))).toEqual(new Set(Object.keys(PROVISIONING_FAILURE_MESSAGES)));
  });
});

describe('classifyProvisioningFailure', () => {
  it('exports exactly the four codes', () => {
    expect(PROVISIONING_FAILURE_CODES).toEqual(['area_code_unavailable', 'credentials_missing', 'provider_error', 'unknown']);
  });

  it.each(BUILT.map((b) => [b.name, b.code, b] as const))('%s → %s', (_name, code, b) => {
    expect(classifyProvisioningFailure(b.text)).toBe(code);
  });

  it.each([
    // Node 22's fetch: a network failure, an AbortSignal.timeout expiry, a plain abort.
    ['fetch failed', 'provider_error'],
    ['The operation was aborted due to timeout', 'provider_error'],
    ['This operation was aborted', 'provider_error'],
  ] as const)('runtime network text %j → %s', (text, code) => {
    expect(classifyProvisioningFailure(text)).toBe(code);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['   '],
    ['duplicate key value violates unique constraint "uq_x"'],
    ['Something odd happened'],
    // A builder's text with extra words around it is not that text.
    ['Wrapped: TENANT_ENCRYPTION_KEY must be set'],
    ['fetch failed badly'],
  ] as const)('%j → unknown', (text) => {
    expect(classifyProvisioningFailure(text)).toBe('unknown');
  });
});
