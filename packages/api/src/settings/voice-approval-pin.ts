/**
 * WS21a — enrolled voice-approval PIN (hashed at rest).
 *
 * Money-class / irreversible voice approvals on a caller-ID-recognized owner
 * line require a spoken PIN (see ai/tasks/proposal-approval-task.ts). Before
 * WS21a the PIN lived as INTERIM PLAINTEXT in
 * `escalation_settings.voice_approval_challenge`; the challenge machinery was
 * complete but nothing ever enrolled a value. WS21a keeps the exact same
 * dialogue and lockout behavior but stores an HMAC-SHA256 of the normalized
 * digits instead of the raw PIN.
 *
 * Secret convention (investigated): the repo's tenant-secrets key is
 * `TENANT_ENCRYPTION_KEY` — it already encrypts tenant OAuth tokens
 * (integrations/crypto.ts, token-crypto.ts), call transcripts
 * (workers/transcription.ts), and Google-review credentials. That is the
 * correct pepper for a hashed-at-rest tenant secret; `WEBHOOK_SIGNING_SECRET`
 * is the documented fallback (it is the only other server-wide secret and is
 * present in shared/config.ts). A per-tenant SALT is folded in via `tenantId`
 * in the HMAC input, so the same PIN under two tenants yields different
 * digests and a leaked digest cannot be replayed across tenants.
 *
 * This module is pure and lives in the settings layer (no `ai/` dependency).
 * Callers pass ALREADY-NORMALIZED digits — the ai-layer owns spoken-digit
 * parsing ("four two seven one" → "4271" via `spokenDigits`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Enrollment accepts 4–6 digits — long enough to resist trivial guessing,
 *  short enough to speak/tap. Mirrors the legacy schema's `min(4)` floor. */
export const MIN_PIN_DIGITS = 4;
export const MAX_PIN_DIGITS = 6;

/**
 * The server-wide secret used to key the PIN HMAC. `TENANT_ENCRYPTION_KEY`
 * first (the tenant-secrets key), then `WEBHOOK_SIGNING_SECRET`. Returns null
 * when neither is set — enrollment then fails loudly (can't securely store)
 * and verification fails closed (a stored hash can never match).
 */
export function resolveVoiceApprovalPinSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const key = env.TENANT_ENCRYPTION_KEY ?? env.WEBHOOK_SIGNING_SECRET;
  return key && key.trim().length > 0 ? key : null;
}

/** Strip everything but digits. "1 2 3 4" / "1-2-3-4" → "1234". */
export function normalizeEnrollmentPin(raw: string): string {
  return (raw ?? '').replace(/\D+/g, '');
}

/** True iff the raw input normalizes to a 4–6 digit PIN. */
export function isEnrollablePin(raw: string): boolean {
  const digits = normalizeEnrollmentPin(raw);
  return digits.length >= MIN_PIN_DIGITS && digits.length <= MAX_PIN_DIGITS;
}

/**
 * HMAC-SHA256 of the normalized digits, keyed by the tenant-secrets key and
 * salted by tenantId. Returns a hex digest. `digits` MUST already be
 * normalized (digits only). Throws if the secret is empty — callers must
 * resolve a real secret (never hash under an empty key).
 */
export function hashVoiceApprovalPin(
  digits: string,
  tenantId: string,
  secret: string,
): string {
  if (!secret) throw new Error('voice-approval PIN hash requires a secret');
  if (!tenantId) throw new Error('voice-approval PIN hash requires a tenantId');
  return createHmac('sha256', secret).update(`${tenantId}:${digits}`).digest('hex');
}

/**
 * Constant-time comparison of a candidate PIN (normalized digits) against a
 * stored hash. Fail-closed: returns false on an empty candidate, empty stored
 * hash, or any length/format mismatch that would make `timingSafeEqual` throw.
 */
export function voiceApprovalPinMatches(
  candidateDigits: string,
  storedHash: string,
  tenantId: string,
  secret: string,
): boolean {
  if (!candidateDigits || !storedHash || !secret) return false;
  let computed: string;
  try {
    computed = hashVoiceApprovalPin(candidateDigits, tenantId, secret);
  } catch {
    return false;
  }
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
