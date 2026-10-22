/**
 * U7 (S6-3) — the lease token every demo callback carries (plan "Callbacks
 * find the lease by a signed token, not by `call_sid`").
 *
 * Minted after the lease transaction commits and before the `Calls`
 * request, so a callback that beats the `Calls` response still names its
 * lease. `base64url(JSON{ a: 'demo_lease', l, t, gen, sexp }).HMAC-SHA256`,
 * verified with `timingSafeEqual`: the construction of
 * `proposals/one-tap-undo.ts` minus the nonce (one call produces several
 * callbacks, so the token is not single-use) and minus any expiry other than
 * `sexp`, the status-callback deadline (`demo_calls.callback_deadline_at`).
 * The lease's own expiry moves when the first live callback renews it, so
 * the token never carries it; the lease row gates voice turns. The required
 * discriminator is why a one-tap approve or undo token signed with the same
 * secret can never verify here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEMO_LEASE_TOKEN_ACTION = 'demo_lease' as const;

interface LeaseTokenPayload {
  a: typeof DEMO_LEASE_TOKEN_ACTION;
  /** demo_tenant_leases.id */
  l: string;
  /** The leased demo tenant. */
  t: string;
  /** The lease's generation, read back from the insert. */
  gen: number;
  /** Status-callback deadline, epoch ms. */
  sexp: number;
}

export interface MintLeaseTokenInput {
  leaseId: string;
  tenantId: string;
  gen: number;
  /** Epoch ms: `demo_calls.callback_deadline_at`. */
  sexp: number;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function mintLeaseToken(input: MintLeaseTokenInput, secret: string): string {
  if (!secret) throw new Error('lease token requires a secret');
  if (!input.leaseId) throw new Error('lease token requires a lease id');
  if (!input.tenantId) throw new Error('lease token requires a tenant id');
  if (!Number.isSafeInteger(input.gen) || input.gen < 0) throw new Error('lease token requires an integer generation');
  if (!Number.isFinite(input.sexp)) throw new Error('lease token requires a status expiry');
  const payload: LeaseTokenPayload = {
    a: DEMO_LEASE_TOKEN_ACTION,
    l: input.leaseId,
    t: input.tenantId,
    gen: input.gen,
    sexp: input.sexp,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export type LeaseTokenFailure = 'malformed' | 'bad_signature' | 'wrong_action' | 'expired';

export type LeaseTokenVerifyResult =
  | { ok: true; leaseId: string; tenantId: string; gen: number; sexp: Date }
  | { ok: false; reason: LeaseTokenFailure };

/**
 * Verify signature, discriminator and shape, then `sexp` against `now`. A
 * token at or past `sexp` is `expired` (S6-6: the status callback answers
 * 200 and does nothing). Never throws.
 */
export function verifyLeaseToken(token: string, secret: string, now: Date): LeaseTokenVerifyResult {
  if (typeof token !== 'string' || !secret) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;

  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(sign(payloadB64, secret), 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'malformed' };
  }
  const p = payload as Partial<Record<keyof LeaseTokenPayload, unknown>>;
  if (p.a !== DEMO_LEASE_TOKEN_ACTION) return { ok: false, reason: 'wrong_action' };
  if (
    typeof p.l !== 'string' ||
    !p.l ||
    typeof p.t !== 'string' ||
    !p.t ||
    typeof p.gen !== 'number' ||
    !Number.isSafeInteger(p.gen) ||
    p.gen < 0 ||
    typeof p.sexp !== 'number' ||
    !Number.isFinite(p.sexp)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (now.getTime() >= p.sexp) return { ok: false, reason: 'expired' };
  return { ok: true, leaseId: p.l, tenantId: p.t, gen: p.gen, sexp: new Date(p.sexp) };
}
