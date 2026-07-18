/**
 * Unit tests for the shared claim-before-send ledger (T4-F01). Mocked Pool —
 * asserts the SQL shape (query text + params) and withSendClaim's
 * compose/release/finalize control flow. Per CLAUDE.md, a mocked-Pool test is
 * never the only proof the SQL is valid against real Postgres — see
 * test/integration/send-claim-ledger.test.ts for the Docker-gated proof of
 * the actual constraint/UPSERT semantics.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  claimSend,
  markSendClaimComplete,
  releaseSendClaim,
  withSendClaim,
} from '../../src/notifications/send-claim-ledger';

const TENANT = 'tenant-1';

function fakePool(rowCount: number): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rowCount, rows: [] }) as unknown as QueryResult);
  return { pool: { query } as unknown as Pool, query };
}

describe('claimSend', () => {
  it('issues an INSERT ... ON CONFLICT DO UPDATE ... WHERE stale, returns true on a row', async () => {
    const { pool, query } = fakePool(1);
    const claimed = await claimSend(pool, TENANT, 'thank_you_sms:job-1');
    expect(claimed).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO send_claims/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, claim_key\) DO UPDATE/);
    expect(sql).toMatch(/WHERE send_claims\.status = 'claimed'/);
    expect(sql).toMatch(/send_claims\.claimed_at < NOW\(\) - \(\$3 \|\| ' minutes'\)::interval/);
    expect(params).toEqual([TENANT, 'thank_you_sms:job-1', '15']);
  });

  it('returns false when no row comes back (already claimed fresh, or already sent)', async () => {
    const { pool } = fakePool(0);
    expect(await claimSend(pool, TENANT, 'thank_you_sms:job-1')).toBe(false);
  });

  it('threads a custom staleMinutes into the query params', async () => {
    const { pool, query } = fakePool(1);
    await claimSend(pool, TENANT, 'k', 30);
    expect(query.mock.calls[0][1]).toEqual([TENANT, 'k', '30']);
  });
});

describe('markSendClaimComplete', () => {
  it('issues the permanent-tombstone UPDATE', async () => {
    const { pool, query } = fakePool(1);
    await markSendClaimComplete(pool, TENANT, 'k');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE send_claims SET status = 'sent', sent_at = NOW\(\)/);
    expect(params).toEqual([TENANT, 'k']);
  });
});

describe('releaseSendClaim', () => {
  it('issues a DELETE scoped to status = claimed (never touches a sent row)', async () => {
    const { pool, query } = fakePool(1);
    await releaseSendClaim(pool, TENANT, 'k');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM send_claims WHERE tenant_id = \$1 AND claim_key = \$2 AND status = 'claimed'/);
    expect(params).toEqual([TENANT, 'k']);
  });
});

describe('withSendClaim', () => {
  it('claims, sends, finalizes — returns {outcome: "sent", result}', async () => {
    const { pool, query } = fakePool(1);
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'sent', result: 'ok' });
    expect(sendFn).toHaveBeenCalledTimes(1);
    // claim INSERT + finalize UPDATE = 2 queries; no release DELETE.
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE send_claims SET status = 'sent'/);
  });

  it('returns {outcome: "duplicate"} without calling sendFn when the claim is not won', async () => {
    const { pool, query } = fakePool(0);
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate' });
    expect(sendFn).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1); // claim attempt only
  });

  it('releases the claim and rethrows unchanged when sendFn throws', async () => {
    const { pool, query } = fakePool(1);
    const sendFn = vi.fn(async () => {
      throw new Error('provider down');
    });
    await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow('provider down');
    expect(query).toHaveBeenCalledTimes(2); // claim INSERT + release DELETE
    expect(query.mock.calls[1][0]).toMatch(/DELETE FROM send_claims/);
  });

  it('swallows a release failure so the original send error still propagates', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockRejectedValueOnce(new Error('db down on release'));
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => {
      throw new Error('provider down');
    });
    await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow('provider down');
  });
});
