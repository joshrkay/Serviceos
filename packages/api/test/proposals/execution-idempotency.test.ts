import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { ExecutionResult } from '../../src/proposals/execution/handlers';

describe('P2-011 — Execution idempotency controls', () => {
  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: 'user-1',
  };

  function makeExecutedProposal(overrides?: Partial<CreateProposalInput>): Proposal {
    const input = { ...baseInput, ...overrides };
    let proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    proposal = transitionProposal(proposal, 'executed', 'user-1');
    proposal.executedAt = new Date();
    proposal.executedBy = 'user-1';
    proposal.resultEntityId = 'entity-123';
    return proposal;
  }

  function makeApprovedProposal(overrides?: Partial<CreateProposalInput>): Proposal {
    const input = { ...baseInput, ...overrides };
    let proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    return proposal;
  }

  const successResult: ExecutionResult = {
    success: true,
    resultEntityId: 'new-entity-456',
  };

  it('happy path — first execution succeeds', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);
    const proposal = makeApprovedProposal({ idempotencyKey: 'key-1' });
    await repo.create(proposal);

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(proposal, executeFn);

    expect(result.success).toBe(true);
    expect(alreadyExecuted).toBe(false);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('happy path — retry with same key returns previous result', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await repo.create(executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(true);
    expect(result.resultEntityId).toBe('entity-123');
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('happy path — different key executes normally', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await repo.create(executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-2' });

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('validation — proposal without key executes directly', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);
    const proposal = makeApprovedProposal(); // no idempotencyKey

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(proposal, executeFn);

    expect(result.success).toBe(true);
    expect(alreadyExecuted).toBe(false);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('tenant isolation — same key different tenant executes independently', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1', tenantId: 'tenant-1' });
    await repo.create(executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1', tenantId: 'tenant-2' });

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('idempotency — already executed not re-executed', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await repo.create(executed);

    const retryProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = jest.fn().mockResolvedValue(successResult);
    await guard.checkAndExecute(retryProposal, executeFn);
    await guard.checkAndExecute(retryProposal, executeFn);

    expect(executeFn).not.toHaveBeenCalled();
  });

  it('invalid transition — non-executed previous result not treated as duplicate', async () => {
    const repo = new InMemoryProposalRepository();
    const guard = new IdempotencyGuard(repo);

    // Create a proposal with same key but in approved (not executed) status
    const approvedProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });
    await repo.create(approvedProposal);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = jest.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});
