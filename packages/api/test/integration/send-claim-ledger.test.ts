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
  markSendClaimComplete,
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
    expect(second).toEqual({ outcome: 'duplicate' });
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
});
