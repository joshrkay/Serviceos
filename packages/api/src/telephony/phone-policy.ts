/**
 * #880 — number-policy predicate for Twilio "magic" test numbers.
 *
 * Twilio's test credentials operate exclusively on the fictitious
 * +1 (500) 555-01xx block (e.g. +15005550006, the "valid, purchasable"
 * magic number — see https://www.twilio.com/docs/iam/test-credentials).
 * These numbers are never real, dialable lines. The dev-stub provisioning
 * path (workers/provision-twilio.ts) deliberately writes +15005550006 so
 * onboarding is completable without Twilio creds — that write is fine;
 * what must never happen is a magic number being SURFACED publicly as a
 * tenant's business line, CLAIMED via the onboarding number picker, or
 * PERSISTED by the real (paid) provisioning path.
 *
 * Deliberately dumb and explicit: the whole +1500555xxxx exchange is
 * treated as test-only. Area code 500 is NANP "personal communications"
 * space, and 500-555-xxxx is not an assignable block — there is no
 * legitimate tenant line to false-positive on. Input is expected in
 * E.164 (`+1XXXXXXXXXX`), the only shape Twilio returns and the only
 * shape our normalized write paths persist.
 *
 * Sibling of voice/outbound-allowlist.ts (isOutboundAllowed), the
 * codebase's other number-policy predicate.
 */
const TWILIO_TEST_NUMBER = /^\+1500555\d{4}$/;

export function isTwilioTestNumber(e164: string): boolean {
  return TWILIO_TEST_NUMBER.test(e164.trim());
}
