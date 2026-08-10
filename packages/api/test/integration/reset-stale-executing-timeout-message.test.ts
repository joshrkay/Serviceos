/**
 * Postgres integration — PgProposalRepository.resetStaleExecuting's
 * execution_error stamp (PR #815 review, second pass, closer 2).
 *
 * The unit tests (test/proposals/pg-proposal.test.ts) can only mock the
 * Pool, so they pin the SQL SHAPE and, via a hand-rendering of the `||`
 * chain, the WORDING — but they never hand the query to a real Postgres
 * planner. That matters here specifically because the UPDATE uses `$1` in
 * TWO different type contexts in the same statement: the new
 * `$1::text` (in the COALESCE fallback expression) and the pre-existing
 * `($1 || ' minutes')::INTERVAL` (in the WHERE clause). node-pg sends an
 * untyped parameter for `$1`, and Postgres must settle on ONE type for it
 * across the whole statement — the explicit `::text` cast is believed to
 * pin that resolution, and the interval cast is believed to still work from
 * a text-typed `$1`, but a mock can't parse SQL and prove either belief. If
 * that read is wrong, the failure is a hard throw inside the stale-recovery
 * sweep — a path that only runs when something is already going wrong — so
 * it would fail at the worst possible moment and mask the original problem.
 *
 * Runs only under `npm run test:integration` (no local Docker in this
 * environment — this file is write-only here; CI executes it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { staleExecutionTimeoutMessage } from '../../src/proposals/proposal';

async function seedStaleExecuting(
  pool: Pool,
  tenantId: string,
  opts: {
    idempotencyKey: string;
    claimedMinutesAgo: number;
    retryCount: number;
    executionError?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const claimedAt = new Date(Date.now() - opts.claimedMinutesAgo * 60 * 1000);
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, status, payload, idempotency_key, created_by,
        claimed_by, claimed_at, execution_retry_count, execution_error)
     VALUES ($1, $2, $3, 'executing', $4::jsonb, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tenantId,
      'create_customer',
      '{}',
      opts.idempotencyKey,
      'voice',
      'execution-worker',
      claimedAt,
      opts.retryCount,
      opts.executionError ?? null,
    ],
  );
  return id;
}

async function rowOf(pool: Pool, id: string): Promise<{ status: string; executionError: string | null }> {
  const r = await pool.query('SELECT status, execution_error FROM proposals WHERE id = $1', [id]);
  return { status: r.rows[0].status as string, executionError: r.rows[0].execution_error as string | null };
}

describe('Postgres integration — resetStaleExecuting execution_error stamp', () => {
  let pool: Pool;
  let repo: PgProposalRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgProposalRepository(pool);
  });

  it('stamps execution_error with staleExecutionTimeoutMessage(...) when a stale executing proposal exhausts retries', async () => {
    const tenant = await createTestTenant(pool);
    const staleMinutes = 10;
    const maxRetries = 3;
    const id = await seedStaleExecuting(pool, tenant.tenantId, {
      idempotencyKey: 'reset-stale-timeout-msg-1',
      claimedMinutesAgo: staleMinutes + 5, // older than the threshold
      retryCount: maxRetries, // already at the cap — this run terminalizes it
      executionError: null,
    });

    const result = await repo.resetStaleExecuting(staleMinutes, maxRetries);
    // resetStaleExecuting is a cross-tenant sweep (no tenant filter) — assert
    // on this row directly rather than on aggregate counts, which could
    // include unrelated stale rows from elsewhere in the suite.
    expect(result.failedProposals.some((p) => p.id === id)).toBe(true);

    const row = await rowOf(pool, id);
    expect(row.status).toBe('execution_failed');
    // The real point of this file: the rendered SQL expression, evaluated by
    // the actual Postgres planner (not a mock), equals the InMemory
    // backend's message byte-for-byte.
    expect(row.executionError).toBe(staleExecutionTimeoutMessage(staleMinutes, maxRetries));
  });

  it('does not clobber an execution_error already recorded, even though the row is also moved to execution_failed', async () => {
    const tenant = await createTestTenant(pool);
    const staleMinutes = 10;
    const maxRetries = 3;
    const preExisting = 'a real reason recorded earlier';
    const id = await seedStaleExecuting(pool, tenant.tenantId, {
      idempotencyKey: 'reset-stale-timeout-msg-2',
      claimedMinutesAgo: staleMinutes + 5,
      retryCount: maxRetries,
      executionError: preExisting,
    });

    await repo.resetStaleExecuting(staleMinutes, maxRetries);

    const row = await rowOf(pool, id);
    expect(row.status).toBe('execution_failed');
    expect(row.executionError).toBe(preExisting);
  });

  /**
   * Follow-up review J4 — the RETRY branch of the same statement pair. The
   * unit test can only see `execution_error = NULL` in the SQL text; this
   * proves a real planner actually clears the column, and that the clear is
   * scoped to the branch that resets (the terminal branch above must keep
   * COALESCE-ing, which the two tests above pin).
   */
  it('clears execution_error when the row is reset to approved for another retry', async () => {
    const tenant = await createTestTenant(pool);
    const staleMinutes = 10;
    const maxRetries = 3;
    const id = await seedStaleExecuting(pool, tenant.tenantId, {
      idempotencyKey: 'reset-stale-clears-cause',
      claimedMinutesAgo: staleMinutes + 5,
      // BELOW the cap — this run retries rather than terminalizing.
      retryCount: 0,
      executionError: 'SMTP relay refused the message',
    });

    await repo.resetStaleExecuting(staleMinutes, maxRetries);

    const row = await rowOf(pool, id);
    expect(row.status).toBe('approved');
    // The previous attempt's reason must not survive into the fresh attempt:
    // GET /api/proposals/:id returns the full Proposal, so carrying it means
    // an operator sees an error string on a proposal that went on to succeed.
    expect(row.executionError).toBeNull();
  });
});
