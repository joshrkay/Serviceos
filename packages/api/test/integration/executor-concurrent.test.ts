import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant } from './shared';
import { PgProposalRepository } from '../../src/proposals/pg-proposal';
import { PgProposalExecutionRepository } from '../../src/proposals/pg-proposal-execution';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { PgIdempotencyLockProvider } from '../../src/proposals/execution/idempotency-lock';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import {
  ExecutionContext,
  ExecutionHandler,
  ExecutionResult,
} from '../../src/proposals/execution/handlers';
import { Proposal, ProposalType } from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';

/**
 * §11 H1 — concurrent execute() on the same approved proposal must
 * invoke the handler at most once (advisory lock + idempotency).
 */
describe('ProposalExecutor — concurrent idempotency (§11 H1)', () => {
  let pool: Pool;
  let proposalRepo: PgProposalRepository;
  let executionRepo: PgProposalExecutionRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    proposalRepo = new PgProposalRepository(pool);
    executionRepo = new PgProposalExecutionRepository(pool);
  });

  it('parallel execute collapses to one handler invocation', async () => {
    const tenant = await createTestTenant(pool);
    let handlerInvocations = 0;
    const handler: ExecutionHandler = {
      proposalType: 'create_customer',
      async execute(): Promise<ExecutionResult> {
        handlerInvocations += 1;
        await new Promise((r) => setTimeout(r, 50));
        return { success: true, resultEntityId: 'entity-1' };
      },
    };
    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', handler],
    ]);
    const guard = new IdempotencyGuard(
      executionRepo,
      proposalRepo,
      new PgIdempotencyLockProvider(pool),
    );
    const executor = new ProposalExecutor(
      handlers,
      proposalRepo,
      guard,
      new PgAuditRepository(pool),
      { executionRepo },
    );

    let proposal = await proposalRepo.create({
      tenantId: tenant.tenantId,
      proposalType: 'create_customer',
      payload: { name: 'Concurrent Test' },
      summary: 'concurrent',
      createdBy: tenant.userId,
      idempotencyKey: `concurrent-${randomUUID()}`,
    });
    proposal = transitionProposal(proposal, 'ready_for_review', 'test');
    proposal = transitionProposal(proposal, 'approved', 'test');
    proposal = {
      ...proposal,
      approvedAt: new Date(Date.now() - 10_000),
    };

    const ctx: ExecutionContext = {
      tenantId: tenant.tenantId,
      executedBy: tenant.userId,
    };
    await Promise.all([
      executor.execute(proposal, ctx),
      executor.execute(proposal, ctx),
    ]);

    expect(handlerInvocations).toBe(1);
    const rows = await executionRepo.listByProposal(tenant.tenantId, proposal.id);
    const succeeded = rows.filter((r) => r.status === 'succeeded');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
  });
});
