/**
 * TEST-CONTACTS-ONLY GATE.
 *
 * Until go-live, the nurture engine may send to these addresses ONLY,
 * regardless of transport (Resend or preview) or environment. This is
 * enforced in the SEND path (src/lib/nurture/engine.ts), not in config, so a
 * stray real address cannot receive a send even if a real RESEND_API_KEY is
 * configured.
 */
export const TEST_CONTACT_ALLOWLIST: readonly string[] = [
  'test+rivet@example.com',
  'test+mike@example.com',
  'test+jenna@example.com',
];

/**
 * GO_LIVE_UNLOCK — LOUD WARNING —
 *
 * This constant gates whether the allowlist is enforced at all. It must stay
 * `false` in every commit. Flipping it to `true` is a HUMAN GO-LIVE ACTION,
 * taken deliberately outside of normal feature work, once:
 *   1. A real RESEND_API_KEY (or equivalent) is configured, and
 *   2. Someone has consciously decided this build is allowed to email real
 *      prospects.
 * Do not flip this as part of a routine code change, a test fixture, or to
 * "make the demo work" — the demo works fine against the allowlist using the
 * test addresses above.
 */
export const GO_LIVE_UNLOCK = false;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** True only for addresses on the allowlist (or always-true once GO_LIVE_UNLOCK flips). */
export function isAllowedTestContact(email: string | null | undefined): boolean {
  if (GO_LIVE_UNLOCK) return true;
  if (!email) return false;
  const normalized = normalize(email);
  return TEST_CONTACT_ALLOWLIST.some((allowed) => normalize(allowed) === normalized);
}

export interface SendGateResult {
  allowed: boolean;
  blocked: boolean;
  reason?: string;
}

/**
 * The hard gate called from the send path. Returns a structured result so the
 * caller can log `{ blocked: true, reason: 'not a test contact' }` exactly as
 * required, regardless of which transport would otherwise have been used.
 */
export function checkSendGate(email: string | null | undefined): SendGateResult {
  if (isAllowedTestContact(email)) {
    return { allowed: true, blocked: false };
  }
  return { allowed: false, blocked: true, reason: 'not a test contact' };
}
