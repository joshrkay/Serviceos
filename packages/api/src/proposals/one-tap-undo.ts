/**
 * UB-D / D-015 (D3) — one-tap UNDO token for autonomous-lane bookings.
 *
 * When the autonomous booking lane auto-approves a booking with no
 * supervisor present, the owner is texted a link carrying one of these
 * tokens. Tapping it undoes the booking: still-approved proposals go
 * through the existing `undoProposal` path; already-executed bookings get
 * a compensating cancellation + fixed-template customer apology (see
 * routes/one-tap-undo.ts).
 *
 * Mirrors the HMAC one-tap APPROVE token in `proposals/auto-approve.ts`
 * byte-for-byte in mechanics (HMAC-SHA256 over a base64url payload,
 * `randomBytes(16)` single-use nonce, TTL clamped to 30 minutes,
 * `timingSafeEqual` verification) — that file is deliberately NOT
 * modified. The payload carries a REQUIRED `a: 'undo_booking'` action
 * discriminator, so an approve token can never verify as an undo token
 * (and vice versa: the approve verifier rejects unknown `a` values) even
 * though both are signed with the same secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ONE_TAP_APPROVE_MAX_TTL_MS } from './auto-approve';

/** Hard ceiling on undo-link lifetime — same 30-minute posture as approve. */
export const ONE_TAP_UNDO_MAX_TTL_MS = ONE_TAP_APPROVE_MAX_TTL_MS;

/** The action discriminator baked into every undo token. */
export const ONE_TAP_UNDO_ACTION = 'undo_booking' as const;

/**
 * Signed payload. Compact single-letter keys mirror the approve token:
 *   p — proposal_id of the lane-approved booking proposal
 *   t — tenant_id
 *   n — nonce (single-use)
 *   e — expiry, epoch ms
 *   a — REQUIRED action discriminator ('undo_booking')
 */
interface OneTapUndoPayload {
  p: string;
  t: string;
  n: string;
  e: number;
  a: typeof ONE_TAP_UNDO_ACTION;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export interface CreateOneTapUndoTokenInput {
  proposalId: string;
  tenantId: string;
  /** HMAC secret (server-side; production wires the one-tap secret). */
  secret: string;
  /** Clamped to ONE_TAP_UNDO_MAX_TTL_MS. */
  ttlMs?: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface OneTapUndoToken {
  token: string;
  nonce: string;
  expiresAt: Date;
}

export function createOneTapUndoToken(input: CreateOneTapUndoTokenInput): OneTapUndoToken {
  if (!input.secret) throw new Error('one-tap undo token requires a secret');
  if (!input.proposalId) throw new Error('one-tap undo token requires a proposalId');
  const now = input.nowMs ?? Date.now();
  const ttl = Math.min(input.ttlMs ?? ONE_TAP_UNDO_MAX_TTL_MS, ONE_TAP_UNDO_MAX_TTL_MS);
  const payload: OneTapUndoPayload = {
    p: input.proposalId,
    t: input.tenantId,
    n: randomBytes(16).toString('base64url'),
    e: now + ttl,
    a: ONE_TAP_UNDO_ACTION,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${payloadB64}.${sign(payloadB64, input.secret)}`;
  return { token, nonce: payload.n, expiresAt: new Date(payload.e) };
}

export type OneTapUndoVerifyFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'tenant_mismatch'
  | 'already_used';

export interface VerifyOneTapUndoTokenInput {
  token: string;
  secret: string;
  /** When set, the token's tenant must match (cross-tenant replay guard). */
  expectedTenantId?: string;
  nowMs?: number;
  /**
   * Single-use nonce consumer. Production wires the same durable
   * `webhook_events` receipt store the approve route uses (distinct
   * source, so approve and undo nonces can never collide).
   */
  consumeNonce: (nonce: string) => boolean | Promise<boolean>;
}

export type OneTapUndoVerifyResult =
  | { ok: true; action: typeof ONE_TAP_UNDO_ACTION; proposalId: string; tenantId: string }
  | { ok: false; reason: OneTapUndoVerifyFailure };

export async function verifyOneTapUndoToken(
  input: VerifyOneTapUndoTokenInput,
): Promise<OneTapUndoVerifyResult> {
  const parts = input.token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;

  const expected = sign(payloadB64, input.secret);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: OneTapUndoPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    typeof payload.p !== 'string' ||
    typeof payload.t !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.e !== 'number' ||
    // REQUIRED discriminator — an approve token (no `a`, or a different
    // action) can never redeem as an undo.
    payload.a !== ONE_TAP_UNDO_ACTION
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const now = input.nowMs ?? Date.now();
  if (now >= payload.e) return { ok: false, reason: 'expired' };
  if (input.expectedTenantId && input.expectedTenantId !== payload.t) {
    return { ok: false, reason: 'tenant_mismatch' };
  }

  const fresh = await input.consumeNonce(payload.n);
  if (!fresh) return { ok: false, reason: 'already_used' };

  return {
    ok: true,
    action: ONE_TAP_UNDO_ACTION,
    proposalId: payload.p,
    tenantId: payload.t,
  };
}
