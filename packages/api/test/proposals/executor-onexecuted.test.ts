import { describe, it, expect, vi } from 'vitest';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import {
  Proposal,
  InMemoryProposalRepository,
  createProposal,
} from '../../src/proposals/proposal';
import { ExecutionHandler } from '../../src/proposals/execution/handlers';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { transitionProposal } from '../../src/proposals/lifecycle';

// Phase 4a-1 regression suite for the new onExecuted callback + the
// proposal_executions row write. Existing executor.test.ts coverage of
// happy-path execution / status transitions / IdempotencyGuard
// short-circuit stays intact — this file only adds the new optional
// surface introduced for the proposal-correction-worker.

const TENANT_A = '11111111-1111-1111-1111-111111111111';

function approvedProposal(overrides: Partial<Proposal> = {}): Proposal {
  // Bypass the 5-second undo window by stamping approvedAt > 5s ago.
  const past = new Date(Date.now() - 6_000);
  const proposal = createProposal({
    tenantId: TENANT_A,
    proposalType: 'create_customer',
    payload: { name: 'AI Drafted Customer' },
    summary: 'create customer',
    createdBy: 'user-1',
    ...overrides,
  });
  let p = transitionProposal(proposal, 'ready_for_review', 'user-1');
  p = transitionProposal(p, 'approved', 'user-1');
  p.approvedAt = past;
  return p;
}

function passingHandler(resultEntityId = 'entity-1'): ExecutionHandler {
  return {
    proposalType: 'create_customer',
    async execute() {
      return { success: true, resultEntityId };
    },
  };
}

function failingHandler(error = 'boom'): ExecutionHandler {
  return {
    proposalType: 'create_customer',
    async execute() {
      return { success: false, error };
    },
  };
}

describe('ProposalExecutor — Phase 4a-1 onExecuted + proposal_executions row', () => {
  it('writes a proposal_executions row on success and fires onExecuted with executionId', async () => {
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const onExecuted = vi.fn(async () => undefined);
    const handlers = new Map([['create_customer', passingHandler('entity-42')]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, undefined, {
      executionRepo,
      onExecuted,
    });

    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    const rows = await executionRepo.listByProposal(TENANT_A, proposal.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].executedPayload).toEqual({ name: 'AI Drafted Customer' });

    expect(onExecuted).toHaveBeenCalledTimes(1);
    const event = onExecuted.mock.calls[0][0] as Parameters<NonNullable<typeof onExecuted>>[0];
    expect(event.proposalId).toBe(proposal.id);
    expect(event.status).toBe('succeeded');
    expect(event.executionId).toBe(rows[0].id);
  });

  it('writes a failed proposal_executions row on handler failure and fires onExecuted with status=failed', async () => {
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const onExecuted = vi.fn(async () => undefined);
    const handlers = new Map([['create_customer', failingHandler('handler-blew-up')]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, undefined, {
      executionRepo,
      onExecuted,
    });

    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    const rows = await executionRepo.listByProposal(TENANT_A, proposal.id);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].errorMessage).toBe('handler-blew-up');

    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect(onExecuted.mock.calls[0][0].status).toBe('failed');
  });

  it('callback errors do not surface as execute() errors (failure-soft)', async () => {
    const repo = new InMemoryProposalRepository();
    const handlers = new Map([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const onExecuted = vi.fn(async () => {
      throw new Error('downstream queue is down');
    });
    const executor = new ProposalExecutor(handlers, repo, undefined, { onExecuted });

    // Despite the callback throwing, the executor should resolve cleanly.
    const result = await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });
    expect(result.result.success).toBe(true);
    expect(onExecuted).toHaveBeenCalledTimes(1);
  });

  it('without executionRepo: no row written, onExecuted still fires (executionId undefined)', async () => {
    const repo = new InMemoryProposalRepository();
    const handlers = new Map([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    await repo.create(proposal);
    const onExecuted = vi.fn(async () => undefined);

    const executor = new ProposalExecutor(handlers, repo, undefined, { onExecuted });
    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect(onExecuted.mock.calls[0][0].executionId).toBeUndefined();
  });

  it('idempotency-key on the proposal flows into the proposal_executions row', async () => {
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = new Map([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    proposal.idempotencyKey = 'idem-7';
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, undefined, { executionRepo });
    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    const rows = await executionRepo.listByProposal(TENANT_A, proposal.id);
    expect(rows[0].idempotencyKey).toBe('idem-7');
  });
});
