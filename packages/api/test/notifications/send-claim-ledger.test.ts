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
  findStuckSendClaims,
  markSendClaimComplete,
  markSendClaimSending,
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

describe('markSendClaimSending', () => {
  it('issues the sending-transition UPDATE, scoped to a claimed row, returns true when it advanced', async () => {
    const { pool, query } = fakePool(1);
    const advanced = await markSendClaimSending(pool, TENANT, 'k');
    expect(advanced).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE send_claims SET status = 'sending'/);
    expect(sql).toMatch(/WHERE tenant_id = \$1 AND claim_key = \$2 AND status = 'claimed'/);
    expect(params).toEqual([TENANT, 'k']);
  });

  it('returns false when the row was no longer "claimed" (0 rows) — the CAS was lost to a concurrent process', async () => {
    const { pool } = fakePool(0);
    expect(await markSendClaimSending(pool, TENANT, 'k')).toBe(false);
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
  it('issues a DELETE scoped to status IN (claimed, sending) (never touches a sent row)', async () => {
    const { pool, query } = fakePool(1);
    await releaseSendClaim(pool, TENANT, 'k');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(
      /DELETE FROM send_claims\s+WHERE tenant_id = \$1 AND claim_key = \$2 AND status IN \('claimed', 'sending'\)/,
    );
    expect(params).toEqual([TENANT, 'k']);
  });
});

describe('findStuckSendClaims', () => {
  it('selects rows stuck at "sending" older than the given window', async () => {
    const query = vi.fn(async () => ({
      rowCount: 1,
      rows: [{ tenant_id: TENANT, claim_key: 'k', claimed_at: new Date('2026-07-18T00:00:00Z') }],
    }) as unknown as QueryResult);
    const pool = { query } as unknown as Pool;
    const stuck = await findStuckSendClaims(pool, 60);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE status = 'sending'/);
    expect(sql).toMatch(/claimed_at < NOW\(\) - \(\$1 \|\| ' minutes'\)::interval/);
    expect(params).toEqual(['60']);
    expect(stuck).toEqual([
      { tenantId: TENANT, claimKey: 'k', claimedAt: new Date('2026-07-18T00:00:00Z') },
    ]);
  });
});

describe('withSendClaim', () => {
  it('claims, transitions to sending, sends, finalizes — returns {outcome: "sent", result}', async () => {
    const { pool, query } = fakePool(1);
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'sent', result: 'ok' });
    expect(sendFn).toHaveBeenCalledTimes(1);
    // claim INSERT + sending UPDATE + finalize UPDATE = 3 queries; no release DELETE.
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE send_claims SET status = 'sending'/);
    expect(query.mock.calls[2][0]).toMatch(/UPDATE send_claims SET status = 'sent'/);
  });

  it('transitions to sending BEFORE calling sendFn (order matters for the crash-safety fix)', async () => {
    const { pool, query } = fakePool(1);
    const callOrder: string[] = [];
    query.mockImplementation(async (sql: string) => {
      callOrder.push(sql.includes('sending') ? 'sending-update' : sql.trim().split(/\s+/)[0]);
      return { rowCount: 1, rows: [] } as unknown as QueryResult;
    });
    const sendFn = vi.fn(async () => {
      callOrder.push('sendFn');
      return 'ok';
    });
    await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(callOrder).toEqual(['INSERT', 'sending-update', 'sendFn', 'UPDATE']);
  });

  it('returns duplicate + priorStatus "sent" without calling sendFn when a tombstone owns the key', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // claim miss
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sent' }] }); // status read
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    expect(sendFn).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2); // claim attempt + status read
  });

  it('returns duplicate + priorStatus "claimed" when another in-flight claim owns the key', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'claimed' }] });
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate', priorStatus: 'claimed' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('returns duplicate + priorStatus "sending" when another process\'s provider call is in flight (or crashed mid-flight)', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // claim miss
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sending' }] }); // status read
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate', priorStatus: 'sending' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('returns duplicate + priorStatus "unknown" when the losing row vanished before the status read', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // concurrent release deleted it
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate', priorStatus: 'unknown' });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('Codex P1 — aborts to duplicate WITHOUT calling sendFn (and never releases) when the sending CAS is lost after claiming', async () => {
    // claimSend succeeds (we won a fresh/stale claim), but by the time the
    // sending UPDATE runs a concurrent process has already advanced the row,
    // so it affects 0 rows. We must NOT call the provider, and must NOT delete
    // the winner's in-flight 'sending' row.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // claim INSERT — we won a claim
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // sending UPDATE — lost the CAS
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sending' }] }); // status read
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => 'ok');
    const result = await withSendClaim(pool, TENANT, 'k', sendFn);
    expect(result).toEqual({ outcome: 'duplicate', priorStatus: 'sending' });
    expect(sendFn).not.toHaveBeenCalled();
    // claim INSERT + sending UPDATE + status read = 3; NO release DELETE, NO finalize.
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toMatch(/SELECT status FROM send_claims/);
    expect(query.mock.calls.every((c) => !/DELETE FROM send_claims/.test(c[0] as string))).toBe(
      true,
    );
  });

  it('releases the claim (from "sending") and rethrows unchanged when sendFn throws', async () => {
    const { pool, query } = fakePool(1);
    const sendFn = vi.fn(async () => {
      throw new Error('provider down');
    });
    await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow('provider down');
    // claim INSERT + sending UPDATE + release DELETE
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][0]).toMatch(/UPDATE send_claims SET status = 'sending'/);
    expect(query.mock.calls[2][0]).toMatch(/DELETE FROM send_claims/);
  });

  it('swallows a release failure so the original send error still propagates', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // claim INSERT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // sending UPDATE
      .mockRejectedValueOnce(new Error('db down on release')); // release DELETE
    const pool = { query } as unknown as Pool;
    const sendFn = vi.fn(async () => {
      throw new Error('provider down');
    });
    await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow('provider down');
  });

  describe('Codex P1 #2 — markProviderAccepted signal', () => {
    it('a post-provider-acceptance bookkeeping throw finalizes the claim to "sent" (never released) and still rethrows', async () => {
      const { pool, query } = fakePool(1);
      const sendFn = vi.fn(async (markProviderAccepted: () => void) => {
        // Provider call succeeds first...
        markProviderAccepted();
        // ...then the caller's own post-send bookkeeping throws.
        throw new Error('dispatch-row write failed');
      });
      await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow(
        'dispatch-row write failed',
      );
      // claim INSERT + sending UPDATE + finalize UPDATE ('sent') — NO release DELETE.
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[1][0]).toMatch(/UPDATE send_claims SET status = 'sending'/);
      expect(query.mock.calls[2][0]).toMatch(/UPDATE send_claims SET status = 'sent'/);
    });

    it('a throw BEFORE markProviderAccepted still releases the claim (unchanged pre-send-failure behavior)', async () => {
      const { pool, query } = fakePool(1);
      const sendFn = vi.fn(async (_markProviderAccepted: () => void) => {
        throw new Error('provider down');
      });
      await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow('provider down');
      expect(query.mock.calls[2][0]).toMatch(/DELETE FROM send_claims/);
    });

    it('swallows a finalize failure after provider-acceptance so the original bookkeeping error still propagates', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // claim INSERT
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // sending UPDATE
        .mockRejectedValueOnce(new Error('db down on finalize')); // finalize UPDATE ('sent')
      const pool = { query } as unknown as Pool;
      const sendFn = vi.fn(async (markProviderAccepted: () => void) => {
        markProviderAccepted();
        throw new Error('dispatch-row write failed');
      });
      await expect(withSendClaim(pool, TENANT, 'k', sendFn)).rejects.toThrow(
        'dispatch-row write failed',
      );
    });
  });
});

/**
 * Lifecycle tests against a lightweight in-memory Postgres simulation (not a
 * real DB — see test/integration/send-claim-ledger.test.ts for that): models
 * enough of send_claims' actual predicate semantics (status filters,
 * claimed_at staleness) to pin the three-state crash-safety fix end to end,
 * rather than only asserting on SQL text shape.
 */
describe('withSendClaim + claimSend — three-state crash-safety lifecycle', () => {
  interface SimRow {
    status: 'claimed' | 'sending' | 'sent';
    claimedAt: number;
  }

  function simulatedPool(rows = new Map<string, SimRow>()): { pool: Pool; rows: Map<string, SimRow> } {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const key = `${params[0]}::${params[1]}`;
      const trimmed = sql.trim();
      if (trimmed.startsWith('INSERT')) {
        const staleMinutes = Number(params[2]);
        const existing = rows.get(key);
        if (!existing) {
          rows.set(key, { status: 'claimed', claimedAt: Date.now() });
          return { rowCount: 1, rows: [] } as unknown as QueryResult;
        }
        const staleMs = staleMinutes * 60_000;
        if (existing.status === 'claimed' && Date.now() - existing.claimedAt >= staleMs) {
          existing.claimedAt = Date.now();
          return { rowCount: 1, rows: [] } as unknown as QueryResult;
        }
        return { rowCount: 0, rows: [] } as unknown as QueryResult;
      }
      if (trimmed.startsWith('UPDATE') && sql.includes("'sending'")) {
        const existing = rows.get(key);
        if (existing?.status === 'claimed') {
          existing.status = 'sending';
          return { rowCount: 1, rows: [] } as unknown as QueryResult;
        }
        return { rowCount: 0, rows: [] } as unknown as QueryResult;
      }
      if (trimmed.startsWith('UPDATE')) {
        const existing = rows.get(key);
        if (existing) existing.status = 'sent';
        return { rowCount: existing ? 1 : 0, rows: [] } as unknown as QueryResult;
      }
      if (trimmed.startsWith('DELETE')) {
        const existing = rows.get(key);
        if (existing && (existing.status === 'claimed' || existing.status === 'sending')) {
          rows.delete(key);
          return { rowCount: 1, rows: [] } as unknown as QueryResult;
        }
        return { rowCount: 0, rows: [] } as unknown as QueryResult;
      }
      if (trimmed.startsWith('SELECT')) {
        const existing = rows.get(key);
        return {
          rowCount: existing ? 1 : 0,
          rows: existing ? [{ status: existing.status }] : [],
        } as unknown as QueryResult;
      }
      throw new Error(`unhandled sql in simulatedPool: ${sql}`);
    });
    return { pool: { query } as unknown as Pool, rows };
  }

  it('happy path: row ends at "sent" and a subsequent claimSend never reclaims it', async () => {
    const { pool, rows } = simulatedPool();
    const outcome = await withSendClaim(pool, TENANT, 'k', async () => 'ok');
    expect(outcome).toEqual({ outcome: 'sent', result: 'ok' });
    expect(rows.get(`${TENANT}::k`)?.status).toBe('sent');

    // Even far past any stale window, a 'sent' tombstone can never be reclaimed.
    expect(await claimSend(pool, TENANT, 'k', 0)).toBe(false);
  });

  it('the post-send crash window is closed: a row stuck at "sending" is NOT reclaimed even past the stale window', async () => {
    const { pool, rows } = simulatedPool();
    // Simulate the crash: claim, transition to sending, then the process
    // dies before sendFn resolves / markSendClaimComplete runs. We drive the
    // same two steps withSendClaim would, then stop short.
    expect(await claimSend(pool, TENANT, 'k')).toBe(true);
    const row = rows.get(`${TENANT}::k`)!;
    row.status = 'sending';
    // Backdate claimed_at well past the stale window — the OLD ('claimed'
    // only) bug would have let this be reclaimed and re-sent.
    row.claimedAt = Date.now() - 60 * 60_000;

    const reclaimed = await claimSend(pool, TENANT, 'k', 15);
    expect(reclaimed).toBe(false);
    expect(rows.get(`${TENANT}::k`)?.status).toBe('sending');
  });

  it('Codex P1 — stale-reclaim race: A passes claimSend then stalls >staleMinutes; B reclaims + fully sends; A\'s sending CAS loses, so A aborts to duplicate and the provider is called exactly ONCE', async () => {
    const { pool: basePool, rows } = simulatedPool();
    let aProvider = 0;
    let bProvider = 0;

    // Wrap the pool handed to process A: the instant A's claimSend INSERT
    // lands, model A stalling past the stale window (backdate its claimed_at)
    // and let a SECOND process B run a full withSendClaim in that gap. B
    // reclaims the now-stale 'claimed' row, wins the sending CAS, sends, and
    // tombstones as 'sent' — all before A resumes to its own sending CAS.
    const aPool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        const res = await (basePool.query as unknown as (s: string, p: unknown[]) => Promise<QueryResult>)(sql, params);
        if (sql.trim().startsWith('INSERT')) {
          rows.get(`${TENANT}::k`)!.claimedAt = Date.now() - 60 * 60_000;
          const bOutcome = await withSendClaim(basePool, TENANT, 'k', async () => {
            bProvider++;
            return 'B-sent';
          });
          expect(bOutcome).toEqual({ outcome: 'sent', result: 'B-sent' });
        }
        return res;
      }),
    } as unknown as Pool;

    const aOutcome = await withSendClaim(aPool, TENANT, 'k', async () => {
      aProvider++;
      return 'A-sent';
    });

    // A won its claim but LOST the sending CAS to B, so it must report a
    // duplicate against B's tombstone and never touch the provider.
    expect(aOutcome).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    expect(aProvider).toBe(0);
    expect(bProvider).toBe(1); // exactly one real send despite two claim winners
    expect(rows.get(`${TENANT}::k`)?.status).toBe('sent');
  });

  it('a caught sendFn error releases the claim (from "sending") so an immediate retry can re-claim and resend', async () => {
    const { pool, rows } = simulatedPool();
    const failing = vi.fn(async () => {
      throw new Error('provider down');
    });
    await expect(withSendClaim(pool, TENANT, 'k', failing)).rejects.toThrow('provider down');
    expect(rows.has(`${TENANT}::k`)).toBe(false); // released, not stuck

    const outcome = await withSendClaim(pool, TENANT, 'k', async () => 'retried-ok');
    expect(outcome).toEqual({ outcome: 'sent', result: 'retried-ok' });
  });

  it('Codex P1 #2: provider-accepted-then-bookkeeping-throw ends the row at "sent" (not released), and a second invocation is a duplicate no-op — never a resend', async () => {
    const { pool, rows } = simulatedPool();
    let providerCalls = 0;
    const bookkeepingFails = vi.fn(async (markProviderAccepted: () => void) => {
      providerCalls++;
      markProviderAccepted(); // the provider genuinely accepted the message
      throw new Error('dispatch-row write failed'); // then bookkeeping throws
    });

    await expect(withSendClaim(pool, TENANT, 'k', bookkeepingFails)).rejects.toThrow(
      'dispatch-row write failed',
    );
    expect(rows.get(`${TENANT}::k`)?.status).toBe('sent');
    expect(providerCalls).toBe(1);

    // A second invocation for the same key must NOT re-invoke the provider —
    // the claim is a permanent 'sent' tombstone, so this is a clean duplicate.
    const secondSendFn = vi.fn(async () => 'should-not-run');
    const outcome = await withSendClaim(pool, TENANT, 'k', secondSendFn);
    expect(outcome).toEqual({ outcome: 'duplicate', priorStatus: 'sent' });
    expect(secondSendFn).not.toHaveBeenCalled();
    expect(providerCalls).toBe(1); // still just the one real provider call
  });
});
