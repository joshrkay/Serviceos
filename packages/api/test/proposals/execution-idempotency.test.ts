import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import {
  InMemoryProposalExecutionRepository,
  ProposalExecutionRepository,
} from '../../src/proposals/proposal-execution';
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

  /**
   * Persist an "executed" proposal together with its matching
   * proposal_executions row — mirrors what the real executor will write
   * once Tasks 4 & 5 wire `ProposalExecutionRepository.recordExecution`
   * into the success path. The guard's lookup is now indexed off the
   * executions table, so the row must exist for retries to short-circuit.
   */
  async function persistExecuted(
    proposalRepo: InMemoryProposalRepository,
    executionRepo: ProposalExecutionRepository,
    proposal: Proposal,
  ): Promise<void> {
    await proposalRepo.create(proposal);
    if (!proposal.idempotencyKey) {
      throw new Error('persistExecuted: proposal must have an idempotencyKey to create an execution row');
    }
    await executionRepo.recordExecution({
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      executedPayload: proposal.payload,
      executedBy: proposal.executedBy ?? 'user-1',
      status: 'succeeded',
      idempotencyKey: proposal.idempotencyKey,
    });
  }

  const successResult: ExecutionResult = {
    success: true,
    resultEntityId: 'new-entity-456',
  };

  it('happy path — first execution succeeds', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const proposal = makeApprovedProposal({ idempotencyKey: 'key-1' });
    await proposalRepo.create(proposal);

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(proposal, executeFn);

    expect(result.success).toBe(true);
    expect(alreadyExecuted).toBe(false);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('happy path — retry with same key returns previous result', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await persistExecuted(proposalRepo, executionRepo, executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(true);
    expect(result.resultEntityId).toBe('entity-123');
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('happy path — different key executes normally', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await persistExecuted(proposalRepo, executionRepo, executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-2' });

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('validation — proposal without key executes directly', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    const proposal = makeApprovedProposal(); // no idempotencyKey

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(proposal, executeFn);

    expect(result.success).toBe(true);
    expect(alreadyExecuted).toBe(false);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('tenant isolation — same key different tenant executes independently', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1', tenantId: 'tenant-1' });
    await persistExecuted(proposalRepo, executionRepo, executed);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1', tenantId: 'tenant-2' });

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('idempotency — already executed not re-executed', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);

    const executed = makeExecutedProposal({ idempotencyKey: 'key-1' });
    await persistExecuted(proposalRepo, executionRepo, executed);

    const retryProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = vi.fn().mockResolvedValue(successResult);
    await guard.checkAndExecute(retryProposal, executeFn);
    await guard.checkAndExecute(retryProposal, executeFn);

    expect(executeFn).not.toHaveBeenCalled();
  });

  it('invalid transition — non-executed previous result not treated as duplicate', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const guard = new IdempotencyGuard(executionRepo, proposalRepo);

    // Create a proposal with same key but in approved (not executed) status — no execution row.
    const approvedProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });
    await proposalRepo.create(approvedProposal);

    const newProposal = makeApprovedProposal({ idempotencyKey: 'key-1' });

    const executeFn = vi.fn().mockResolvedValue(successResult);
    const { result, alreadyExecuted } = await guard.checkAndExecute(newProposal, executeFn);

    expect(alreadyExecuted).toBe(false);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it('uses the executions repository for the key lookup (indexed path)', async () => {
    const proposalRepo = new InMemoryProposalRepository();
    const executionRepo = new InMemoryProposalExecutionRepository();
    const findByIdempotencyKeySpy = vi.spyOn(executionRepo, 'findByIdempotencyKey');
    const findByTenantSpy = vi.spyOn(proposalRepo, 'findByTenant');

    const guard = new IdempotencyGuard(executionRepo, proposalRepo);
    await guard.findPreviousExecution('t1', 'some-key');

    expect(findByIdempotencyKeySpy).toHaveBeenCalledWith('t1', 'some-key');
    expect(findByTenantSpy).not.toHaveBeenCalled();
  });
});
