import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from '../../src/proposals/execution/handlers';
import { Proposal, ProposalType } from '../../src/proposals/proposal';

/**
 * §11 H1 (Task 6) — End-to-end proof that the wired-in IdempotencyGuard
 * collapses a double-delivered proposal to a single execution row.
 *
 * Scenario: queue redelivery (or operator re-approval after a network
 * blip) causes `ProposalExecutor.execute()` to be called twice with the
 * same approved proposal. The guard must short-circuit the second call
 * via the `proposal_executions_tenant_idempotency_uniq` index (migration
 * 099, Task 1), returning `alreadyExecuted: true` with the *same*
 * `resultEntityId` as the first run — and the handler must never fire
 * a second mutation.
 *
 * Invariants asserted:
 *   1. Exactly one row in `proposal_executions` per (tenant, key).
 *   2. The handler ran exactly once (entity counter does not advance).
 *   3. Second call returns `alreadyExecuted: true` with the first
 *      run's `resultEntityId`.
 *
 * Container lifecycle is owned by vitest globalSetup; this file is a
 * no-op when run without `TEST_DB_URL` (see test/integration/shared.ts).
 */
describe('ProposalExecutor — double-delivery idempotency (§11 H1)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
  });

  // Build a fresh executor + invocation counter per test. Keeping the
  // counter local (closed over by the handler) eliminates the shared
  // mutable state that previously leaked across `it` blocks via a
  // module-level `let`, which made test ordering matter.
  //
  // The handler returns a fresh `resultEntityId` per invocation so a
  // second call (if the guard failed to short-circuit) would return a
  // *different* id — and the resultEntityId equality assertion below
  // would fail loudly.
  function setupExecutor(): {
    executor: ProposalExecutor;
    getInvocations: () => number;
  } {
    let handlerInvocations = 0;
    const handler: ExecutionHandler = {
      proposalType: 'create_customer',
      async execute(
        _proposal: Proposal,
        _context: ExecutionContext,
      ): Promise<ExecutionResult> {
        handlerInvocations += 1;
        return { success: true, resultEntityId: `entity-${handlerInvocations}` };
      },
    };
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', handler],
    ]);
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const executor = new ProposalExecutor(
      handlers,
      proposalRepo,
      guard,
      new PgAuditRepository(pool),
      { executionRepo },
    );
    return { executor, getInvocations: () => handlerInvocations };
  }

  it('records exactly one execution when the same proposal is executed twice', async () => {
    const { executor, getInvocations } = setupExecutor();
    const tenant = await createTestTenant(pool);
    const idempotencyKey = `dup-key-${randomUUID().slice(0, 8)}`;
    const proposalId = await createApprovedProposal(
      pool,
      tenant.tenantId,
      tenant.userId,
      idempotencyKey,
    );

    // First delivery — handler must run, status transitions to
    // 'executed', proposal_executions row written.
    const loaded1 = await proposalRepo.findById(tenant.tenantId, proposalId);
    expect(loaded1).not.toBeNull();
    const ctx: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };
    const first = await executor.execute(loaded1!, ctx);
    expect(first.result.success).toBe(true);
    expect(first.alreadyExecuted).toBe(false);
    const firstEntityId = first.result.resultEntityId;
    expect(firstEntityId).toBe('entity-1');
    expect(getInvocations()).toBe(1);

    // Second delivery — simulate queue redelivery by reloading the
    // proposal fresh from the DB. The post-execution row has status
    // 'executed' but the guard's lookup is via the executions table on
    // (tenant_id, idempotency_key), independent of proposal status.
    //
    // NOTE: the executor refuses statuses other than 'approved' or
    // 'executing'. After the first call the proposal is 'executed', so
    // we re-stage it as 'approved' to model the precise scenario the
    // guard exists to defend against: same idempotency key, same
    // already-side-effected work, presented to the executor again
    // (e.g., SQS at-least-once redelivery before the worker ack'd, or
    // an operator re-clicking Approve before the UI refreshed). Without
    // re-staging we'd be testing the wrong invariant (status guard
    // rather than idempotency guard).
    //
    // We deliberately do NOT clear result_entity_id: in real
    // redelivery the column stays populated from the first execute()
    // (only the worker's post-execute status transition was lost). The
    // guard reconstructs `resultEntityId` from this column on the
    // short-circuit path, so clearing it would break the equality
    // assertion without modeling a real-world scenario.
    await pool.query(
      `UPDATE proposals SET status = 'approved', approved_at = NULL,
                            executed_at = NULL, executed_by = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, proposalId],
    );

    const loaded2 = await proposalRepo.findById(tenant.tenantId, proposalId);
    expect(loaded2).not.toBeNull();
    const second = await executor.execute(loaded2!, ctx);
    expect(second.result.success).toBe(true);
    expect(second.alreadyExecuted).toBe(true);
    expect(second.result.resultEntityId).toBe(firstEntityId);

    // Critical: handler did NOT run a second time. If the guard had
    // failed, this would be 2 and resultEntityId above would be
    // 'entity-2' instead of 'entity-1'.
    expect(getInvocations()).toBe(1);

    // Exactly one row in proposal_executions for this (tenant, key).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, idempotencyKey],
    );
    expect(rows[0].n).toBe(1);

    // Defensive: the single row must belong to *this* proposal. Guards
    // against a future maintainer introducing ambiguous idempotency
    // keys that could let one tenant's redelivery resolve to a
    // different proposal's prior execution row.
    const { rows: execRows } = await pool.query(
      `SELECT proposal_id FROM proposal_executions
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, idempotencyKey],
    );
    expect(execRows[0].proposal_id).toBe(proposalId);
  });

  it('records exactly one execution row on a clean first delivery', async () => {
    const { executor, getInvocations } = setupExecutor();
    const tenant = await createTestTenant(pool);
    const idempotencyKey = `fresh-key-${randomUUID().slice(0, 8)}`;
    const proposalId = await createApprovedProposal(
      pool,
      tenant.tenantId,
      tenant.userId,
      idempotencyKey,
    );

    const loaded = await proposalRepo.findById(tenant.tenantId, proposalId);
    expect(loaded).not.toBeNull();
    const result = await executor.execute(loaded!, {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    });
    expect(result.alreadyExecuted).toBe(false);
    expect(getInvocations()).toBe(1);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM proposal_executions
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, idempotencyKey],
    );
    expect(rows[0].n).toBe(1);
  });
});

/**
 * Insert a proposals row in 'approved' status with `approved_at = NULL`
 * so the executor's 5-second undo window is bypassed
 * (`isInUndoWindow` returns false when `approvedAt` is missing — see
 * lifecycle.ts:55). Mirrors the createProposal helpers in the sibling
 * integration tests but adds the status override.
 *
 * proposal_type must be 'create_customer' to match the handler
 * registered in beforeAll, otherwise the executor throws
 * HANDLER_NOT_FOUND.
 */
async function createApprovedProposal(
  pool: Pool,
  tenantId: string,
  createdBy: string,
  idempotencyKey: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO proposals
       (id, tenant_id, proposal_type, status, payload,
        idempotency_key, created_by, approved_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      id,
      tenantId,
      'create_customer',
      'approved',
      JSON.stringify({ name: 'Test Customer' }),
      idempotencyKey,
      createdBy,
      null,
    ],
  );
  return id;
}
