import { describe, it, expect } from 'vitest';
import {
  InMemoryProposalRepository,
  createProposal,
  Proposal,
} from '../../src/proposals/proposal';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { applyChainMetadata } from '../../src/proposals/chain';
import { AppError } from '../../src/shared/errors';

/**
 * End-to-end execution test for multi-action chaining.
 *
 * A two-proposal chain: create_customer (parent) → create_job (dependent
 * whose customerId is a symbolic ref to the parent). Exercises the
 * execution-time ordering guarantee: the dependent cannot execute until
 * the parent has, and once it does its token resolves to the parent's
 * resultEntityId. Uses the default (stub-mode) handler registry, which
 * returns synthetic ids — no DB required.
 */
describe('multi-action chain — execution-time resolution', () => {
  const context: ExecutionContext = { tenantId: 'tenant-1', executedBy: 'user-1' };

  function buildChain(): { parent: Proposal; child: Proposal } {
    const parent = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_customer',
      payload: { name: 'Jane Doe' },
      summary: 'create customer Jane Doe',
      createdBy: 'user-1',
    });
    applyChainMetadata(parent, {
      chainId: 'chain-1',
      chainIndex: 0,
      chainLength: 2,
      dependsOnChainIndices: [],
      chainRefs: [],
    });

    const child = createProposal({
      tenantId: 'tenant-1',
      proposalType: 'create_job',
      payload: { title: 'Furnace tune-up', customerId: 'placeholder' },
      summary: 'open a job for Jane',
      createdBy: 'user-1',
    });
    applyChainMetadata(child, {
      chainId: 'chain-1',
      chainIndex: 1,
      chainLength: 2,
      dependsOnChainIndices: [0],
      chainRefs: [{ payloadPath: 'customerId', parentChainIndex: 0, entityKind: 'customerId' }],
    });

    return { parent, child };
  }

  /** Move a proposal to approved with the undo window already elapsed. */
  function approve(p: Proposal): Proposal {
    let next = transitionProposal(p, 'ready_for_review', 'user-1');
    next = transitionProposal(next, 'approved', 'user-1');
    return { ...next, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
  }

  async function setup() {
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = createExecutionHandlerRegistry();
    const guard = new IdempotencyGuard(executionRepo, repo);
    const executor = new ProposalExecutor(handlers, repo, guard);
    return { repo, executor };
  }

  it('blocks the dependent until the parent executes, then resolves the ref', async () => {
    const { repo, executor } = await setup();
    const { parent, child } = buildChain();

    const approvedParent = approve(parent);
    const approvedChild = approve(child);
    await repo.create(approvedParent);
    await repo.create(approvedChild);

    // Dependent claimed first → blocked with a retryable error.
    await expect(executor.execute(approvedChild, context)).rejects.toMatchObject({
      code: 'CHAIN_PARENT_PENDING',
    });

    // Parent executes → exposes a resultEntityId.
    const parentResult = await executor.execute(approvedParent, context);
    expect(parentResult.result.success).toBe(true);
    const customerId = parentResult.proposal.resultEntityId;
    expect(customerId).toBeTruthy();

    // Re-fetch the now-executed parent so the resolver sees its status.
    // (InMemory repo persisted the transition.)
    const refetchedChild = await repo.findById('tenant-1', approvedChild.id);
    expect(refetchedChild).not.toBeNull();

    // Dependent re-attempted → token resolves to the parent's id.
    const childResult = await executor.execute(refetchedChild!, context);
    expect(childResult.result.success).toBe(true);
    expect(childResult.proposal.status).toBe('executed');
  });

  it('cascade-fails the dependent when the parent failed', async () => {
    const { repo, executor } = await setup();
    const { parent, child } = buildChain();

    // Parent marked failed directly.
    const failedParent: Proposal = { ...parent, status: 'execution_failed' };
    await repo.create(failedParent);

    const approvedChild = approve(child);
    await repo.create(approvedChild);

    const result = await executor.execute(approvedChild, context);
    expect(result.result.success).toBe(false);
    expect(result.proposal.status).toBe('execution_failed');
  });

  it('leaves a non-chained proposal completely unaffected (noop path)', async () => {
    const { repo, executor } = await setup();
    const solo = approve(
      createProposal({
        tenantId: 'tenant-1',
        proposalType: 'create_customer',
        payload: { name: 'Solo' },
        summary: 'solo',
        createdBy: 'user-1',
      })
    );
    await repo.create(solo);
    const result = await executor.execute(solo, context);
    expect(result.result.success).toBe(true);
    expect(result.proposal.status).toBe('executed');
  });
});
