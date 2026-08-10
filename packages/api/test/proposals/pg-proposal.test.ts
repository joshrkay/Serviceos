import { describe, it, expect, vi } from 'vitest';
import { Pool, PoolClient, QueryResult } from 'pg';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { staleExecutionTimeoutMessage } from '../../src/proposals/proposal';

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
        // UPDATE ... RETURNING yields POST-update values, so this is what the
        // COALESCE resolved to — here, a real cause recorded earlier by
        // execution-worker.ts on the still-'executing' row.
        execution_error: 'SMTP relay refused the message',
      },
    ]);
    const repo = new PgProposalRepository(pool);

    const result = await repo.resetStaleExecuting(10, 3);

    expect(result.movedToFailed).toBe(1);
    expect(result.failedProposals).toEqual([
      {
        id: 'stale-1',
        tenantId: 'tenant-1',
        proposalType: 'create_customer',
        retryCount: 3,
        executionError: 'SMTP relay refused the message',
      },
    ]);

    const failUpdate = calls.find((c) => /SET\s+status\s*=\s*'execution_failed'/i.test(c.sql));
    expect(failUpdate).toBeDefined();
    // Follow-up — execution_error joins the RETURNING list so the caller can
    // put the real cause on the proposal.execution_timed_out audit event.
    expect(failUpdate!.sql).toMatch(
      /RETURNING\s+id,\s*tenant_id,\s*proposal_type,\s*execution_retry_count,\s*execution_error/i,
    );
  });

  /**
   * Review J4 — reset-to-approved IS the "start a fresh attempt" boundary.
   * The row can now carry a reason recorded by the execution sweep while it
   * was still 'executing', and carrying that into the retry means a
   * proposal that goes on to succeed is served by `GET /api/proposals/:id`
   * with a stale error string on it. Mirror of the InMemory pin in
   * test/proposals/proposal.test.ts.
   */
  it('clears execution_error on the reset-to-approved UPDATE', async () => {
    const { pool, calls } = buildPool([]);
    const repo = new PgProposalRepository(pool);

    await repo.resetStaleExecuting(10, 3);

    const resetUpdate = calls.find((c) => /SET\s+status\s*=\s*'approved'/i.test(c.sql));
    expect(resetUpdate).toBeDefined();
    expect(resetUpdate!.sql).toMatch(/execution_error\s*=\s*NULL/i);
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

  /**
   * PR #815 review, second pass, closer 1 — the shape assertion above pins
   * that a COALESCE exists, but NOT that its wording matches
   * `staleExecutionTimeoutMessage()` (proposal.ts). Since the two can't
   * literally share a JS string (one lives in a SQL literal), the only
   * thing keeping them in sync was a hand-written comment repeated three
   * times — exactly the divergence class this PR exists to close, at small
   * scale: edit the message template and every test still passes while the
   * two backends silently render different text. This test extracts the
   * literal `||` concatenation chain from the emitted SQL, evaluates it in
   * JS (substituting the two placeholders for their bound values), and
   * asserts the RENDERED string equals what the InMemory backend produces —
   * so a wording edit on one side without the other now fails red.
   */
  it('renders the COALESCE fallback expression to exactly staleExecutionTimeoutMessage(staleMinutes, retryCount)', async () => {
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

    // Pull the COALESCE's second argument — the `||` concatenation chain —
    // out of the raw SQL text.
    const match = failUpdate!.sql.match(/COALESCE\(\s*execution_error,\s*([\s\S]*?)\n\s*\)/);
    expect(match).not.toBeNull();
    const expr = match![1];

    // Render it: split on `||`, substitute the two typed placeholders for
    // the values this call used ($1::text → staleMinutes,
    // execution_retry_count::text → the RETURNING row's retry count), and
    // unquote everything else (a SQL string literal, `''`-escaped).
    const rendered = expr
      .split('||')
      .map((part) => part.trim())
      .map((part) => {
        if (part === '$1::text') return '10';
        if (part === 'execution_retry_count::text') return '3';
        return part.replace(/^'|'$/g, '').replace(/''/g, "'");
      })
      .join('');

    expect(rendered).toBe(staleExecutionTimeoutMessage(10, 3));
  });
});
