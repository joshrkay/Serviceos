/**
 * Docker-gated integration test for the `send_claims` ledger (T4-F01) —
 * proves the real constraint/index/UPSERT semantics against Postgres.
 * A mocked-Pool unit test (test/notifications/send-claim-ledger.test.ts)
 * cannot prove the table exists, the PRIMARY KEY is right, or that the
 * partial-UPSERT `WHERE` clause actually gates a reclaim — per CLAUDE.md,
 * DB-touching changes require this real-DB proof.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import {
  claimSend,
  findStuckSendClaims,
  markSendClaimComplete,
  markSendClaimSending,
  releaseSendClaim,
  withSendClaim,
} from '../../src/notifications/send-claim-ledger';

describe('send_claims ledger (integration)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await getSharedTestDb();
  });
  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('claimSend is true once for a fresh key, then false on immediate retry', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'k1')).toBe(true);
    expect(await claimSend(pool, tenantId, 'k1')).toBe(false);
  });

  it('is tenant-scoped: the same claim_key is independent per tenant', async () => {
    const a = await createTestTenant(pool);
    const b = await createTestTenant(pool);
    expect(await claimSend(pool, a.tenantId, 'same-key')).toBe(true);
    expect(await claimSend(pool, b.tenantId, 'same-key')).toBe(true);
  });

  it('reclaims a stale claimed row past the stale window', async () => {
    const { tenantId } = await createTestTenant(pool);
    // Seed a claim row already 20 minutes old (past the default 15-minute window).
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenantId, 'stale-key'],
    );
    // Immediate claim attempt at the default window: succeeds — the row IS stale.
    expect(await claimSend(pool, tenantId, 'stale-key')).toBe(true);
  });

  it('does NOT reclaim a claimed row still inside the stale window', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'fresh-key')).toBe(true);
    // Still fresh (just claimed) — an immediate re-claim attempt must fail.
    expect(await claimSend(pool, tenantId, 'fresh-key')).toBe(false);
  });

  it('a "sent" tombstone is permanent regardless of age — never reclaimed', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'k2')).toBe(true);
    await markSendClaimComplete(pool, tenantId, 'k2');

    // Force the sent row's claimed_at far into the past — if the reclaim
    // WHERE clause incorrectly ignored `status`, this would look reclaimable.
    await pool.query(
      `UPDATE send_claims SET claimed_at = NOW() - INTERVAL '1000 minutes' WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'k2'],
    );
    expect(await claimSend(pool, tenantId, 'k2')).toBe(false);

    const { rows } = await pool.query(
      `SELECT status, sent_at FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'k2'],
    );
    expect(rows[0].status).toBe('sent');
    expect(rows[0].sent_at).not.toBeNull();
  });

  it('releaseSendClaim deletes a claimed row so an immediate re-claim succeeds', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'k3')).toBe(true);
    await releaseSendClaim(pool, tenantId, 'k3');
    expect(await claimSend(pool, tenantId, 'k3')).toBe(true);
  });

  it('releaseSendClaim never deletes a sent row (guarded by status = claimed)', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'k4')).toBe(true);
    await markSendClaimComplete(pool, tenantId, 'k4');
    await releaseSendClaim(pool, tenantId, 'k4');
    const { rows } = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'k4'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sent');
  });

  it('concurrent claimSend calls for the same fresh key: exactly one resolves true', async () => {
    const { tenantId } = await createTestTenant(pool);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimSend(pool, tenantId, 'race-key')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('withSendClaim: happy path sends once, second call is a duplicate no-op', async () => {
    const { tenantId } = await createTestTenant(pool);
    const sendFn = async () => 'sent-result';

    const first = await withSendClaim(pool, tenantId, 'wsc-1', sendFn);
    expect(first).toEqual({ outcome: 'sent', result: 'sent-result' });

    let calledAgain = false;
    const second = await withSendClaim(pool, tenantId, 'wsc-1', async () => {
      calledAgain = true;
      return 'sent-result';
    });
    expect(second).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    expect(calledAgain).toBe(false);
  });

  it('withSendClaim: sendFn throw releases the claim and rethrows; next attempt claims fresh', async () => {
    const { tenantId } = await createTestTenant(pool);
    await expect(
      withSendClaim(pool, tenantId, 'wsc-2', async () => {
        throw new Error('provider outage');
      }),
    ).rejects.toThrow('provider outage');

    // Released — immediate re-claim succeeds (no stale wait required).
    expect(await claimSend(pool, tenantId, 'wsc-2')).toBe(true);
  });

  // --- Three-state crash-safety fix (Codex P1, PR #705) ---------------------
  // Pins the real Postgres semantics of the new 'sending' state: the
  // constraint accepts it, claimSend's WHERE clause never reclaims it
  // (closing the post-send crash window), and release/observability work
  // against it as designed.

  it('full lifecycle against the real table: claimed -> sending -> sent', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'lifecycle-1')).toBe(true);
    let row = (
      await pool.query(
        `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [tenantId, 'lifecycle-1'],
      )
    ).rows[0];
    expect(row.status).toBe('claimed');

    await markSendClaimSending(pool, tenantId, 'lifecycle-1');
    row = (
      await pool.query(
        `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [tenantId, 'lifecycle-1'],
      )
    ).rows[0];
    expect(row.status).toBe('sending');

    await markSendClaimComplete(pool, tenantId, 'lifecycle-1');
    row = (
      await pool.query(
        `SELECT status, sent_at FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
        [tenantId, 'lifecycle-1'],
      )
    ).rows[0];
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
  });

  it('the CHECK constraint accepts "sending" (migration 258 widened it)', async () => {
    const { tenantId } = await createTestTenant(pool);
    await expect(
      pool.query(
        `INSERT INTO send_claims (tenant_id, claim_key, status) VALUES ($1, $2, 'sending')`,
        [tenantId, 'check-sending'],
      ),
    ).resolves.toBeDefined();
  });

  it('the post-send crash window is closed: a manually-inserted stale "sending" row is NOT reclaimed', async () => {
    const { tenantId } = await createTestTenant(pool);
    // Simulate the exact crash this fix targets: a row parked at 'sending'
    // (provider call started) whose claimed_at is now well past the default
    // 15-minute stale window — with the OLD two-state design this row would
    // have been sitting at 'claimed' and WOULD be reclaimed here, causing a
    // resend of a message that may have already gone out.
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'sending', NOW() - INTERVAL '1000 minutes')`,
      [tenantId, 'stuck-sending'],
    );
    expect(await claimSend(pool, tenantId, 'stuck-sending')).toBe(false);

    const { rows } = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'stuck-sending'],
    );
    expect(rows[0].status).toBe('sending');
  });

  it('markSendClaimSending only ever transitions a "claimed" row (no-ops against "sent" or already-"sending")', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'sending-guard')).toBe(true);
    await markSendClaimComplete(pool, tenantId, 'sending-guard');

    // A late/duplicate call to markSendClaimSending after completion must
    // never move a permanent 'sent' tombstone backwards.
    await markSendClaimSending(pool, tenantId, 'sending-guard');
    const { rows } = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'sending-guard'],
    );
    expect(rows[0].status).toBe('sent');
  });

  // --- Codex P1 (PR #705, round 3) — the sending transition is the CAS that
  // serializes the stale-reclaim window --------------------------------------

  it('markSendClaimSending returns true only when it actually advanced a "claimed" row (real-DB rowCount)', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'cas-1')).toBe(true);
    // First transition wins.
    expect(await markSendClaimSending(pool, tenantId, 'cas-1')).toBe(true);
    // Second transition finds the row already 'sending' — 0 rows, returns false.
    expect(await markSendClaimSending(pool, tenantId, 'cas-1')).toBe(false);
    // Against a 'sent' tombstone it is also a false no-op.
    await markSendClaimComplete(pool, tenantId, 'cas-1');
    expect(await markSendClaimSending(pool, tenantId, 'cas-1')).toBe(false);
  });

  it('stale-reclaim race, end-to-end: B reclaims A\'s stalled claim and sends once; A\'s sending CAS then returns false so A cannot double-send', async () => {
    const { tenantId } = await createTestTenant(pool);
    // Process A claimed 20 minutes ago and stalled before transitioning to
    // 'sending' — model it as a stale 'claimed' row.
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, $2, 'claimed', NOW() - INTERVAL '20 minutes')`,
      [tenantId, 'reclaim-race'],
    );

    // Process B runs a full withSendClaim: its claimSend reclaims the stale
    // row, its sending CAS wins, it sends, and it tombstones as 'sent'.
    let bProvider = 0;
    const bOutcome = await withSendClaim(pool, tenantId, 'reclaim-race', async () => {
      bProvider++;
      return 'B-sent';
    });
    expect(bOutcome).toEqual({ outcome: 'sent', result: 'B-sent' });
    expect(bProvider).toBe(1);

    // Process A resumes and attempts its own claimed→sending transition. The
    // row is now 'sent', so the CAS matches 0 rows and returns false — the
    // guard that stops A from calling the provider a second time.
    expect(await markSendClaimSending(pool, tenantId, 'reclaim-race')).toBe(false);
    const { rows } = await pool.query(
      `SELECT status FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'reclaim-race'],
    );
    expect(rows[0].status).toBe('sent');
  });

  it('releaseSendClaim deletes a "sending" row too (the caught-error release path)', async () => {
    const { tenantId } = await createTestTenant(pool);
    expect(await claimSend(pool, tenantId, 'release-sending')).toBe(true);
    await markSendClaimSending(pool, tenantId, 'release-sending');
    await releaseSendClaim(pool, tenantId, 'release-sending');

    // Released — a fresh claim succeeds immediately, no stale wait required.
    expect(await claimSend(pool, tenantId, 'release-sending')).toBe(true);
  });

  it('withSendClaim: a caught sendFn error releases from "sending" (not just "claimed") and a retry re-sends', async () => {
    const { tenantId } = await createTestTenant(pool);
    await expect(
      withSendClaim(pool, tenantId, 'wsc-sending-release', async () => {
        throw new Error('provider outage');
      }),
    ).rejects.toThrow('provider outage');

    // If release only matched status='claimed' (the pre-fix behavior), the
    // row would still be stuck at 'sending' here and this would return false.
    expect(await claimSend(pool, tenantId, 'wsc-sending-release')).toBe(true);
  });

  // --- Codex P1 #2 — post-provider-acceptance bookkeeping failure must not
  // release the claim -----------------------------------------------------

  it('withSendClaim: markProviderAccepted then a throw finalizes "sent" against the real table (not released), and a retry is a duplicate no-op', async () => {
    const { tenantId } = await createTestTenant(pool);
    let providerCalls = 0;

    await expect(
      withSendClaim(pool, tenantId, 'p1-2-real', async (markProviderAccepted) => {
        providerCalls++;
        markProviderAccepted(); // the provider genuinely accepted the message
        throw new Error('dispatch-row write failed'); // then bookkeeping throws
      }),
    ).rejects.toThrow('dispatch-row write failed');

    const { rows } = await pool.query(
      `SELECT status, sent_at FROM send_claims WHERE tenant_id = $1 AND claim_key = $2`,
      [tenantId, 'p1-2-real'],
    );
    expect(rows[0].status).toBe('sent');
    expect(rows[0].sent_at).not.toBeNull();

    // A retry for the same key must be a clean duplicate — never a resend —
    // and must not touch the real provider again.
    const retry = await withSendClaim(pool, tenantId, 'p1-2-real', async () => {
      providerCalls++;
      return 'should-not-run';
    });
    expect(retry).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    expect(providerCalls).toBe(1);
  });

  it('findStuckSendClaims surfaces old "sending" rows but not fresh "sending", "claimed", or "sent" rows', async () => {
    const { tenantId } = await createTestTenant(pool);
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, 'old-sending', 'sending', NOW() - INTERVAL '120 minutes')`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, 'fresh-sending', 'sending', NOW())`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at)
       VALUES ($1, 'old-claimed', 'claimed', NOW() - INTERVAL '120 minutes')`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO send_claims (tenant_id, claim_key, status, claimed_at, sent_at)
       VALUES ($1, 'old-sent', 'sent', NOW() - INTERVAL '120 minutes', NOW() - INTERVAL '120 minutes')`,
      [tenantId],
    );

    const stuck = await findStuckSendClaims(pool, 60);
    const stuckForTenant = stuck.filter((s) => s.tenantId === tenantId);
    expect(stuckForTenant.map((s) => s.claimKey)).toEqual(['old-sending']);
  });
});
