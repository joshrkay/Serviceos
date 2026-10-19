/**
 * S6-3 (U7 "Callbacks find the lease by a signed token") — the lease token:
 * HMAC over base64url JSON with the required `a: 'demo_lease'`
 * discriminator, the lease id, tenant id, `gen` and one expiry `sexp`; no
 * nonce and no other expiry.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { mintLeaseToken, verifyLeaseToken, DEMO_LEASE_TOKEN_ACTION } from '../../src/demo/lease-token';
import { createOneTapApproveToken } from '../../src/proposals/auto-approve';
import { createOneTapUndoToken } from '../../src/proposals/one-tap-undo';

const SECRET = 'lease-secret-for-tests';
const LEASE = '6b1d2a40-1111-4c3e-9f00-000000000001';
const TENANT = '6b1d2a40-2222-4c3e-9f00-000000000002';
const SEXP = Date.UTC(2026, 9, 20, 12, 0, 0);
const BEFORE = new Date(SEXP - 60_000);

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

/** Re-sign a hand-built payload with the real secret (so only its content is wrong). */
function signed(payload: unknown, secret = SECRET): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`;
}

describe('lease token', () => {
  it('round-trips the lease id, tenant id, generation and sexp, with no exp and no nonce', () => {
    const token = mintLeaseToken({ leaseId: LEASE, tenantId: TENANT, gen: 42, sexp: SEXP }, SECRET);
    expect(payloadOf(token)).toEqual({ a: 'demo_lease', l: LEASE, t: TENANT, gen: 42, sexp: SEXP });
    expect(DEMO_LEASE_TOKEN_ACTION).toBe('demo_lease');
    expect(verifyLeaseToken(token, SECRET, BEFORE)).toEqual({
      ok: true,
      leaseId: LEASE,
      tenantId: TENANT,
      gen: 42,
      sexp: new Date(SEXP),
    });
  });

  it('a token at or past sexp does not verify (injected clock)', () => {
    const token = mintLeaseToken({ leaseId: LEASE, tenantId: TENANT, gen: 1, sexp: SEXP }, SECRET);
    expect(verifyLeaseToken(token, SECRET, new Date(SEXP - 1)).ok).toBe(true);
    expect(verifyLeaseToken(token, SECRET, new Date(SEXP))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyLeaseToken(token, SECRET, new Date(SEXP + 3_600_000))).toEqual({ ok: false, reason: 'expired' });
  });

  it('a payload edited to name another lease or tenant fails the signature', () => {
    const token = mintLeaseToken({ leaseId: LEASE, tenantId: TENANT, gen: 1, sexp: SEXP }, SECRET);
    const [, sig] = token.split('.');
    for (const edit of [{ l: TENANT }, { t: LEASE }, { gen: 2 }, { sexp: SEXP + 1 }]) {
      const b64 = Buffer.from(JSON.stringify({ ...payloadOf(token), ...edit })).toString('base64url');
      expect(verifyLeaseToken(`${b64}.${sig}`, SECRET, BEFORE)).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('a flipped signature byte and a token signed under another secret fail', () => {
    const token = mintLeaseToken({ leaseId: LEASE, tenantId: TENANT, gen: 1, sexp: SEXP }, SECRET);
    const [b64, sig] = token.split('.');
    const raw = Buffer.from(sig, 'base64url');
    raw[0] ^= 0x01;
    expect(verifyLeaseToken(`${b64}.${raw.toString('base64url')}`, SECRET, BEFORE)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const other = mintLeaseToken({ leaseId: LEASE, tenantId: TENANT, gen: 1, sexp: SEXP }, 'another-secret');
    expect(verifyLeaseToken(other, SECRET, BEFORE)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('a missing or non-integer gen is malformed even when correctly signed', () => {
    const base = { a: 'demo_lease', l: LEASE, t: TENANT, sexp: SEXP };
    for (const gen of [undefined, '42', 1.5, -1, null]) {
      expect(verifyLeaseToken(signed({ ...base, gen }), SECRET, BEFORE)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(verifyLeaseToken(signed({ ...base, gen: 1, sexp: 'tomorrow' }), SECRET, BEFORE)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('a one-tap approve token and an undo token signed with the same secret fail the discriminator', () => {
    const approve = createOneTapApproveToken({ proposalId: LEASE, tenantId: TENANT, secret: SECRET });
    expect(verifyLeaseToken(approve.token, SECRET, BEFORE)).toEqual({ ok: false, reason: 'wrong_action' });
    const undo = createOneTapUndoToken({ proposalId: LEASE, tenantId: TENANT, secret: SECRET });
    expect(verifyLeaseToken(undo.token, SECRET, BEFORE)).toEqual({ ok: false, reason: 'wrong_action' });
    expect(verifyLeaseToken(signed({ l: LEASE, t: TENANT, gen: 1, sexp: SEXP }), SECRET, BEFORE)).toEqual({
      ok: false,
      reason: 'wrong_action',
    });
  });

  it('malformed input never throws', () => {
    for (const bad of ['', '.', 'abc', 'a.b.c', `${Buffer.from('not json').toString('base64url')}.x`, '%%%.%%%']) {
      expect(verifyLeaseToken(bad, SECRET, BEFORE).ok).toBe(false);
    }
    const notJson = Buffer.from('not json').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(notJson).digest('base64url');
    expect(verifyLeaseToken(`${notJson}.${sig}`, SECRET, BEFORE)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyLeaseToken(signed(['array']), SECRET, BEFORE)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses to mint without a secret, a lease id, a tenant id or an integer generation', () => {
    const ok = { leaseId: LEASE, tenantId: TENANT, gen: 1, sexp: SEXP };
    expect(() => mintLeaseToken(ok, '')).toThrow();
    expect(() => mintLeaseToken({ ...ok, leaseId: '' }, SECRET)).toThrow();
    expect(() => mintLeaseToken({ ...ok, tenantId: '' }, SECRET)).toThrow();
    expect(() => mintLeaseToken({ ...ok, gen: 1.5 }, SECRET)).toThrow();
    expect(() => mintLeaseToken({ ...ok, sexp: Number.NaN }, SECRET)).toThrow();
  });
});
