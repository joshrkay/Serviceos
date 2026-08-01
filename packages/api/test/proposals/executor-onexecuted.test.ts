import { describe, it, expect, vi } from 'vitest';
import { ProposalExecutor, ProposalExecutionEvent } from '../../src/proposals/execution/executor';
import {
  Proposal,
  InMemoryProposalRepository,
  ProposalRepository,
  createProposal,
  ProposalType,
} from '../../src/proposals/proposal';
import { ExecutionHandler } from '../../src/proposals/execution/handlers';
import {
  InMemoryProposalExecutionRepository,
  ProposalExecutionRepository,
} from '../../src/proposals/proposal-execution';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { transitionProposal } from '../../src/proposals/lifecycle';

// §11 H1: the executor now requires an IdempotencyGuard. Proposals
// without an `idempotencyKey` fall through the guard as a passthrough,
// so existing onExecuted/executionRepo tests just need a real guard
// wired in — behavior is unchanged.
function makeGuard(
  executionRepo: ProposalExecutionRepository,
  proposalRepo: ProposalRepository,
): IdempotencyGuard {
  return new IdempotencyGuard(executionRepo, proposalRepo);
}

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
    const onExecuted = vi.fn(async (_event: ProposalExecutionEvent) => undefined);
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', passingHandler('entity-42')]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), {
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
    const onExecuted = vi.fn(async (_event: ProposalExecutionEvent) => undefined);
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', failingHandler('handler-blew-up')]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), {
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
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    await repo.create(proposal);

    const onExecuted = vi.fn(async () => {
      throw new Error('downstream queue is down');
    });
    const executionRepo = new InMemoryProposalExecutionRepository();
    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), { onExecuted });

    // Despite the callback throwing, the executor should resolve cleanly.
    const result = await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });
    expect(result.result.success).toBe(true);
    expect(onExecuted).toHaveBeenCalledTimes(1);
  });

  it('without executionRepo: no row written, onExecuted still fires (executionId undefined)', async () => {
    const repo = new InMemoryProposalRepository();
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    await repo.create(proposal);
    const onExecuted = vi.fn(async (_event: ProposalExecutionEvent) => undefined);

    const executionRepo = new InMemoryProposalExecutionRepository();
    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), { onExecuted });
    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    expect(onExecuted).toHaveBeenCalledTimes(1);
    expect(onExecuted.mock.calls[0][0].executionId).toBeUndefined();
  });

  it('idempotency-key on the proposal flows into the proposal_executions row', async () => {
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const handlers = new Map<ProposalType, ExecutionHandler>([['create_customer', passingHandler()]]);
    const proposal = approvedProposal();
    proposal.idempotencyKey = 'idem-7';
    await repo.create(proposal);

    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), { executionRepo });
    await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });

    const rows = await executionRepo.listByProposal(TENANT_A, proposal.id);
    expect(rows[0].idempotencyKey).toBe('idem-7');
  });

  it('replay (alreadyExecuted=true): onExecuted is NOT fired — spend recorder cannot double-count', async () => {
    // Simulate a replay: first run executes normally (onExecuted fires once).
    // Second call on the SAME proposal — after the execution row exists, the
    // guard short-circuits with alreadyExecuted=true; onExecuted must NOT fire.
    //
    // Note: we re-run the same proposal object (reset to 'approved') rather
    // than creating a duplicate — the idempotency guard looks at the
    // proposal_executions table, not the proposals table.
    const repo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const onExecuted = vi.fn(async (_event: ProposalExecutionEvent) => undefined);

    const proposal = approvedProposal();
    proposal.idempotencyKey = 'idem-replay';
    await repo.create(proposal);

    const handlers = new Map<ProposalType, ExecutionHandler>([
      ['create_customer', passingHandler('entity-replay')],
    ]);
    const executor = new ProposalExecutor(handlers, repo, makeGuard(executionRepo, repo), new InMemoryAuditRepository(), {
      executionRepo,
      onExecuted,
    });

    // First execution — handler runs, onExecuted fires once.
    const first = await executor.execute(proposal, { tenantId: TENANT_A, executedBy: 'user-1' });
    expect(first.alreadyExecuted).toBeFalsy();
    expect(onExecuted).toHaveBeenCalledTimes(1);

    // Second execution of the same proposal (re-approved to bypass status check,
    // simulating re-delivery or retry after a crash). The idempotency guard will
    // find the execution row written by the first run and short-circuit.
    const reapproved = { ...proposal, status: 'approved' as const };
    const second = await executor.execute(reapproved, { tenantId: TENANT_A, executedBy: 'user-1' });
    expect(second.alreadyExecuted).toBe(true);
    // onExecuted must NOT fire on replay — still exactly 1 call total.
    expect(onExecuted).toHaveBeenCalledTimes(1);

    // Sanity: the first execution's row is still there (one row only).
    const rows = await executionRepo.listByProposal(TENANT_A, proposal.id);
    expect(rows.length).toBe(1);
  });
});
