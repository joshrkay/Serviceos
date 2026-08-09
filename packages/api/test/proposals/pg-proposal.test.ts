import { describe, it, expect, vi } from 'vitest';
import { Pool, PoolClient, QueryResult } from 'pg';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';

/**
 * Follow-up — resetStaleExecuting must surface WHICH proposals it moved to
 * the terminal 'execution_failed' state (id/tenantId/proposalType/
 * retryCount), not just an aggregate count, so the caller
 * (execution-worker.ts) can emit a per-proposal
 * `proposal.execution_timed_out` audit event. See
 * test/proposals/proposal.test.ts for the InMemory-side pin and the fuller
 * writeup of the underlying gap (no audit event on a stale-executing
 * timeout).
 *
 * Parity note: since this can only mock the Pool (no real Postgres in this
 * environment), it pins the SQL shape (a RETURNING clause on the
 * already-existing "moved to failed" UPDATE) and the row-mapping — not that
 * the DB actually applies the WHERE clause correctly. That's covered
 * separately by the query's unchanged WHERE clause, which predates this fix.
 */
describe('PgProposalRepository.resetStaleExecuting — failed proposal detail', () => {
  function buildPool(failedRows: Array<Record<string, unknown>>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|RESET\b|SET\s+(LOCAL\s+)?ROLE\b|SELECT set_config)/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        calls.push({ sql, params: params ?? [] });
        if (/SET\s+status\s*=\s*'execution_failed'/i.test(sql)) {
          return { rows: failedRows, rowCount: failedRows.length } as unknown as QueryResult;
        }
        if (/SET\s+status\s*=\s*'approved'/i.test(sql)) {
          return { rows: [], rowCount: 0 } as unknown as QueryResult;
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult;
      }) as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient) as unknown as Pool['connect'],
    };
    return { pool: pool as Pool, calls };
  }

  it('returns failedProposals mapped from the RETURNING rows of the terminal-failure UPDATE', async () => {
    const { pool, calls } = buildPool([
      {
        id: 'stale-1',
        tenant_id: 'tenant-1',
        proposal_type: 'create_customer',
        execution_retry_count: 3,
      },
    ]);
    const repo = new PgProposalRepository(pool);

    const result = await repo.resetStaleExecuting(10, 3);

    expect(result.movedToFailed).toBe(1);
    expect(result.failedProposals).toEqual([
      { id: 'stale-1', tenantId: 'tenant-1', proposalType: 'create_customer', retryCount: 3 },
    ]);

    const failUpdate = calls.find((c) => /SET\s+status\s*=\s*'execution_failed'/i.test(c.sql));
    expect(failUpdate).toBeDefined();
    expect(failUpdate!.sql).toMatch(/RETURNING\s+id,\s*tenant_id,\s*proposal_type,\s*execution_retry_count/i);
  });

  it('returns an empty failedProposals array when nothing moved to failed', async () => {
    const { pool } = buildPool([]);
    const repo = new PgProposalRepository(pool);

    const result = await repo.resetStaleExecuting(10, 3);

    expect(result.movedToFailed).toBe(0);
    expect(result.failedProposals).toEqual([]);
  });

  /**
   * PR #815 review, Important 2 — the terminal-failure UPDATE must also
   * COALESCE-set `execution_error` to a synthesized timeout reason, because
   * `evaluateSilentExecutionFailures` (workers/failure-rate-monitor.ts) and
   * GET /api/proposals both read that column directly — the audit event
   * from execution-worker.ts never reaches either surface. COALESCE (not a
   * plain overwrite) so a real reason recorded earlier survives.
   */
  it('COALESCE-sets execution_error to a synthesized timeout reason on the terminal-failure UPDATE', async () => {
    const { pool, calls } = buildPool([
      {
        id: 'stale-1',
        tenant_id: 'tenant-1',
        proposal_type: 'create_customer',
        execution_retry_count: 3,
      },
    ]);
    const repo = new PgProposalRepository(pool);

    await repo.resetStaleExecuting(10, 3);

    const failUpdate = calls.find((c) => /SET\s+status\s*=\s*'execution_failed'/i.test(c.sql));
    expect(failUpdate).toBeDefined();
    expect(failUpdate!.sql).toMatch(/execution_error\s*=\s*COALESCE\(\s*execution_error\s*,/i);
    // Never a plain overwrite — must not clobber a real reason.
    expect(failUpdate!.sql).not.toMatch(/execution_error\s*=\s*\$/);
  });
});
