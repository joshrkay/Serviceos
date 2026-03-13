import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { transitionProposal } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import {
  createExecutionHandlerRegistry,
  ExecutionContext,
} from '../../src/proposals/execution/handlers';
import { AppError } from '../../src/shared/errors';

describe('P2-010 — Deterministic proposal execution engine', () => {
  const baseInput: CreateProposalInput = {
    tenantId: 'tenant-1',
    proposalType: 'create_customer',
    payload: { name: 'John Doe' },
    summary: 'Create customer from voice call',
    createdBy: 'user-1',
  };

  const context: ExecutionContext = {
    tenantId: 'tenant-1',
    executedBy: 'user-1',
  };

  function makeApprovedProposal(overrides?: Partial<CreateProposalInput>): Proposal {
    const input = { ...baseInput, ...overrides };
    let proposal = createProposal(input);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    return proposal;
  }

  async function setupExecutor() {
    const repo = new InMemoryProposalRepository();
    const handlers = createExecutionHandlerRegistry();
    const executor = new ProposalExecutor(handlers, repo);
    return { repo, handlers, executor };
  }

  it('happy path — executes approved create_customer proposal', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal();
    await repo.create(proposal);

    const { proposal: updated, result } = await executor.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(updated.status).toBe('executed');
    expect(updated.executedBy).toBe('user-1');
    expect(updated.executedAt).toBeInstanceOf(Date);
  });

  it('happy path — executes approved create_job proposal', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal({
      proposalType: 'create_job',
      payload: { customerId: 'cust-123', title: 'Fix plumbing' },
    });
    await repo.create(proposal);

    const { proposal: updated, result } = await executor.execute(proposal, context);

    expect(result.success).toBe(true);
    expect(updated.status).toBe('executed');
  });

  it('happy path — records resultEntityId on success', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal();
    await repo.create(proposal);

    const { proposal: updated, result } = await executor.execute(proposal, context);

    expect(result.resultEntityId).toBeDefined();
    expect(typeof result.resultEntityId).toBe('string');
    expect(updated.resultEntityId).toBe(result.resultEntityId);
  });

  it('validation — rejects non-approved proposal', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = createProposal(baseInput);
    const reviewProposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    await repo.create(reviewProposal);

    await expect(executor.execute(reviewProposal, context)).rejects.toThrow(AppError);
    await expect(executor.execute(reviewProposal, context)).rejects.toThrow(
      "Proposal must be in 'approved' status to execute"
    );
  });

  it('validation — rejects unknown proposal type handler', async () => {
    const { repo } = await setupExecutor();
    const emptyHandlers = new Map();
    const executor = new ProposalExecutor(emptyHandlers, repo);
    const proposal = makeApprovedProposal();
    await repo.create(proposal);

    await expect(executor.execute(proposal, context)).rejects.toThrow(AppError);
    await expect(executor.execute(proposal, context)).rejects.toThrow(
      'No execution handler registered'
    );
  });

  it('happy path — execution failure transitions to execution_failed', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal({
      proposalType: 'create_job',
      payload: { title: 'Fix plumbing' }, // missing customerId
    });
    await repo.create(proposal);

    const { proposal: updated, result } = await executor.execute(proposal, context);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(updated.status).toBe('execution_failed');
  });

  it('tenant isolation — cross-tenant proposal inaccessible', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal({ tenantId: 'tenant-2' });
    await repo.create(proposal);

    // The proposal belongs to tenant-2, but the repo isolates by tenant
    const found = await repo.findById('tenant-1', proposal.id);
    expect(found).toBeNull();
  });

  it('idempotency — already executed proposal rejected', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = makeApprovedProposal();
    await repo.create(proposal);

    const { proposal: executed } = await executor.execute(proposal, context);

    expect(executed.status).toBe('executed');
    await expect(executor.execute(executed, context)).rejects.toThrow(AppError);
    await expect(executor.execute(executed, context)).rejects.toThrow(
      "Proposal must be in 'approved' status to execute"
    );
  });

  it('invalid transition — draft proposal cannot be executed', async () => {
    const { repo, executor } = await setupExecutor();
    const proposal = createProposal(baseInput);
    await repo.create(proposal);

    expect(proposal.status).toBe('draft');
    await expect(executor.execute(proposal, context)).rejects.toThrow(AppError);
    await expect(executor.execute(proposal, context)).rejects.toThrow(
      "Proposal must be in 'approved' status to execute, but is 'draft'"
    );
  });
});
