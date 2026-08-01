/**
 * UB-D / D-015 (D3) — one-tap UNDO token round trip.
 *
 * Mirrors the auto-approve token tests: mint → verify, expiry, tamper,
 * cross-tenant mismatch, single-use nonce. Plus the action-discriminator
 * guard: an APPROVE token can never verify as an UNDO token (and the undo
 * payload's required `a: 'undo_booking'` means the reverse also fails).
 */
import { describe, it, expect } from 'vitest';
import {
  createOneTapUndoToken,
  verifyOneTapUndoToken,
  ONE_TAP_UNDO_MAX_TTL_MS,
} from '../../src/proposals/one-tap-undo';
import {
  createOneTapApproveToken,
  createInMemoryNonceStore,
  ONE_TAP_APPROVE_MAX_TTL_MS,
} from '../../src/proposals/auto-approve';

const TENANT = 't-1';
const PROPOSAL = 'p-1';
const SECRET = 'undo-secret';

describe('one-tap undo token', () => {
  it('round-trips: mint → verify returns the bound proposal + tenant', async () => {
    const { token, nonce, expiresAt } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    expect(nonce).toBeTruthy();
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const result = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      consumeNonce: () => true,
    });
    expect(result).toEqual({
      ok: true,
      action: 'undo_booking',
      proposalId: PROPOSAL,
      tenantId: TENANT,
    });
  });

  it('clamps the TTL to the 30-minute ceiling', () => {
    expect(ONE_TAP_UNDO_MAX_TTL_MS).toBe(ONE_TAP_APPROVE_MAX_TTL_MS);
    const { expiresAt } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
      ttlMs: 24 * 60 * 60 * 1000,
      nowMs: 1_000_000,
    });
    expect(expiresAt.getTime()).toBe(1_000_000 + ONE_TAP_UNDO_MAX_TTL_MS);
  });

  it('rejects an expired token', async () => {
    const { token } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
      ttlMs: 1000,
      nowMs: 1_000_000,
    });
    const result = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      nowMs: 1_000_000 + 1001,
      consumeNonce: () => true,
    });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered payload (bad signature)', async () => {
    const { token } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    const [payloadB64, sig] = token.split('.');
    const forged = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    forged.p = 'p-other';
    const forgedB64 = Buffer.from(JSON.stringify(forged)).toString('base64url');
    const result = await verifyOneTapUndoToken({
      token: `${forgedB64}.${sig}`,
      secret: SECRET,
      consumeNonce: () => true,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a wrong-secret verification', async () => {
    const { token } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    const result = await verifyOneTapUndoToken({
      token,
      secret: 'a-different-secret',
      consumeNonce: () => true,
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a cross-tenant redemption (tenant_mismatch)', async () => {
    const { token } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    const result = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      expectedTenantId: 't-other',
      consumeNonce: () => true,
    });
    expect(result).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });

  it('is single-use: the nonce store rejects a second consumption', async () => {
    const { token } = createOneTapUndoToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    const consumeNonce = createInMemoryNonceStore();
    const first = await verifyOneTapUndoToken({ token, secret: SECRET, consumeNonce });
    expect(first.ok).toBe(true);
    const second = await verifyOneTapUndoToken({ token, secret: SECRET, consumeNonce });
    expect(second).toEqual({ ok: false, reason: 'already_used' });
  });

  it('an APPROVE token can never verify as an UNDO token (missing discriminator)', async () => {
    const { token } = createOneTapApproveToken({
      proposalId: PROPOSAL,
      tenantId: TENANT,
      secret: SECRET,
    });
    const result = await verifyOneTapUndoToken({
      token,
      secret: SECRET,
      consumeNonce: () => true,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects malformed tokens', async () => {
    for (const bad of ['', 'no-dot', 'a.b.c', 'onlypayload.']) {
      const result = await verifyOneTapUndoToken({
        token: bad,
        secret: SECRET,
        consumeNonce: () => true,
      });
      expect(result.ok).toBe(false);
    }
  });
});
