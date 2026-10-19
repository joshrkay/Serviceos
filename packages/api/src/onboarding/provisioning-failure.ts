/**
 * Why the tenant's phone line failed, as a closed code the onboarding status
 * can carry (the raw `tenant_integrations.last_error` text never leaves the
 * server through the status).
 *
 * This module is the one place that knows the texts the Twilio provisioning
 * worker records: the worker (workers/provision-twilio.ts) and the Twilio
 * helpers it calls (integrations/twilio/provisioning.ts) build those texts with
 * the builders below, and the classifier matches against patterns derived from
 * the same builders, so a reworded message changes both sides at once and can
 * never quietly fall through to `unknown`.
 *
 *   area_code_unavailable  the picked number was taken between listing and
 *                          purchase, or there was none left to buy: a new
 *                          number fixes it, so the number turn re-searches;
 *   credentials_missing    the platform's Twilio or encryption credentials are
 *                          unset, or test credentials were detected: nothing
 *                          the owner can do;
 *   provider_error         a Twilio HTTP failure (or a network failure reaching
 *                          Twilio) the queue's retries did not clear;
 *   unknown                null, empty, or any other text (the DID conflict
 *                          with another tenant lands here on purpose: it needs
 *                          a person, not a new search).
 */
export const PROVISIONING_FAILURE_CODES = [
  'area_code_unavailable',
  'credentials_missing',
  'provider_error',
  'unknown',
] as const;
export type ProvisioningFailureCode = (typeof PROVISIONING_FAILURE_CODES)[number];

const didConflict = (phoneE164: string): string =>
  `Phone number ${phoneE164} is already assigned to another tenant — ` +
  'a DID can serve only one tenant (inbound routing resolves the tenant ' +
  'from the number).';

/** The texts the provisioning worker records in `last_error`, one builder per failure. */
export const PROVISIONING_FAILURE_MESSAGES = {
  selectedNumberUnavailable: (phoneNumber: string): string =>
    `Selected number ${phoneNumber} is no longer available — please choose another`,
  noInventory: (region?: string | null): string =>
    `No available US phone numbers found for region ${region ?? 'any'}`,
  twilioCredentialsUnset: (): string => 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set',
  encryptionKeyUnset: (): string => 'TENANT_ENCRYPTION_KEY must be set',
  testCredentials: (phoneE164: string): string =>
    `Refusing to persist Twilio test number ${phoneE164} as the tenant line — ` +
    'the configured Twilio credentials appear to be TEST credentials; ' +
    'fix TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN and re-run provisioning',
  twilioHttp: (method: 'GET' | 'POST' | 'DELETE', url: string, status: number, body: string): string =>
    `Twilio ${method} ${url} → ${status}: ${body}`,
  didAlreadyClaimedReleased: (phoneE164: string): string =>
    `${didConflict(phoneE164)} The number just purchased for this tenant has been released, ` +
    'so nothing is being billed for it. Release the number from the other ' +
    'tenant, or provision this tenant on a different number, then re-run ' +
    'provisioning.',
  didAlreadyClaimedNotReleased: (
    phoneE164: string,
    releaseError: string,
    phoneNumberSid: string,
    subaccountSid: string,
  ): string =>
    `${didConflict(phoneE164)} Releasing the number just purchased for this tenant FAILED ` +
    `(${releaseError}) — release ${phoneNumberSid} from subaccount ` +
    `${subaccountSid} by hand, or the next provisioning run will recover it ` +
    'and hit this same conflict.',
} as const;

type MessageName = keyof typeof PROVISIONING_FAILURE_MESSAGES;

const CODE_BY_MESSAGE: Record<MessageName, ProvisioningFailureCode> = {
  selectedNumberUnavailable: 'area_code_unavailable',
  noInventory: 'area_code_unavailable',
  twilioCredentialsUnset: 'credentials_missing',
  encryptionKeyUnset: 'credentials_missing',
  testCredentials: 'credentials_missing',
  twilioHttp: 'provider_error',
  didAlreadyClaimedReleased: 'unknown',
  didAlreadyClaimedNotReleased: 'unknown',
};

/**
 * Texts Node's fetch produces on its own (not built here): a network failure,
 * an `AbortSignal.timeout` expiry (provisioning.ts sets one on every call),
 * and a plain abort. The worker records `err.message` as is.
 */
const NETWORK_FAILURE_TEXTS = new Set([
  'fetch failed',
  'The operation was aborted due to timeout',
  'This operation was aborted',
]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The whole-message pattern of one builder: call it with a placeholder per
 * argument and let each placeholder match any text. Anchored at both ends, so
 * a builder's text embedded in another message (the conflict text quotes a
 * Twilio DELETE failure) is not that builder's text. The placeholder is
 * wrapped in a private-use character (U+E000), which no recorded text holds.
 */
function patternOf(build: (...args: never[]) => string): RegExp {
  const slots = Array.from({ length: build.length }, (_, i) => `\uE000${i}\uE000`);
  const sample = (build as (...args: string[]) => string)(...slots);
  const literalParts = sample.split(/\uE000\d+\uE000/);
  return new RegExp(`^${literalParts.map(escapeRegExp).join('[\\s\\S]*?')}$`);
}

const PATTERNS: ReadonlyArray<{ pattern: RegExp; code: ProvisioningFailureCode }> = (
  Object.keys(PROVISIONING_FAILURE_MESSAGES) as MessageName[]
).map((name) => ({ pattern: patternOf(PROVISIONING_FAILURE_MESSAGES[name]), code: CODE_BY_MESSAGE[name] }));

/** The closed code for a recorded `last_error` (null, empty or unfamiliar text → `unknown`). */
export function classifyProvisioningFailure(lastError: string | null | undefined): ProvisioningFailureCode {
  if (!lastError) return 'unknown';
  if (NETWORK_FAILURE_TEXTS.has(lastError)) return 'provider_error';
  return PATTERNS.find((p) => p.pattern.test(lastError))?.code ?? 'unknown';
}
