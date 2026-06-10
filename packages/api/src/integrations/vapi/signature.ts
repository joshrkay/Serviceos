/**
 * Vapi webhook signature verification.
 *
 * Vapi authenticates its server messages with a shared secret configured on
 * the assistant (`serverUrlSecret`). We support two header shapes so the
 * verifier works regardless of how the assistant is configured:
 *
 *   - `x-vapi-signature: <hex>` — HMAC-SHA256 of the raw body keyed by the
 *     secret (preferred; tamper-evident).
 *   - `x-vapi-secret: <secret>` — the static shared secret echoed back.
 *
 * Both comparisons are timing-safe. Verification fails closed: no secret, no
 * recognised header, or a mismatch all return false.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** HMAC-SHA256(rawBody) keyed by secret, hex-encoded. */
export function computeVapiHmac(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface VapiSignatureInput {
  rawBody: string;
  secret: string;
  /** Value of the `x-vapi-signature` header (HMAC hex), if present. */
  signatureHeader?: string | null;
  /** Value of the `x-vapi-secret` header (static shared secret), if present. */
  sharedSecretHeader?: string | null;
}

export function verifyVapiSignature(input: VapiSignatureInput): boolean {
  const { rawBody, secret, signatureHeader, sharedSecretHeader } = input;
  if (!secret) return false;

  if (signatureHeader) {
    return safeEqual(signatureHeader.trim(), computeVapiHmac(rawBody, secret));
  }
  if (sharedSecretHeader) {
    return safeEqual(sharedSecretHeader, secret);
  }
  return false;
}
