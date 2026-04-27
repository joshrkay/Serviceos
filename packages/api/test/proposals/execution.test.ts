import {
  createProposal,
  CreateProposalInput,
  InMemoryProposalRepository,
  Proposal,
} from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
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
    // Decision 9 5-second undo window: executor refuses within-window
    // proposals. Existing execution tests assume an approved proposal
    // is immediately executable, so backdate approvedAt past the
    // window. The undo-window behavior is covered explicitly in the
    // "undo window" describe block below.
    proposal = {
      ...proposal,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
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

  // ── Decision 9: 5-second undo window ────────────────────────────────

  describe('5-second undo window', () => {
    it('executor refuses to run a proposal still inside the undo window', async () => {
      const { repo, executor } = await setupExecutor();
      // Fresh approval — approvedAt = now, inside the window.
      const proposal: Proposal = {
        ...makeApprovedProposal(),
        approvedAt: new Date(), // override the backdated helper
      };
      await repo.create(proposal);

      await expect(executor.execute(proposal, context)).rejects.toMatchObject({
        code: 'UNDO_WINDOW_OPEN',
      });
    });

    it('executor runs a proposal whose window has closed', async () => {
      const { repo, executor } = await setupExecutor();
      const proposal = makeApprovedProposal(); // helper backdates past window
      await repo.create(proposal);

      const { result } = await executor.execute(proposal, context);
      expect(result.success).toBe(true);
    });

    it('executor runs historical proposals without approvedAt (backward compat)', async () => {
      const { repo, executor } = await setupExecutor();
      const proposal: Proposal = {
        ...makeApprovedProposal(),
        approvedAt: undefined, // simulate pre-undo-window-slice proposal
      };
      await repo.create(proposal);

      const { result } = await executor.execute(proposal, context);
      expect(result.success).toBe(true);
    });
  });

  // IdempotencyGuard wired into ProposalExecutor. When the same
  // idempotencyKey has already produced an executed proposal,
  // re-executing must NOT call the handler a second time.
  //
  // The repo-level unique constraint blocks duplicate proposals with
  // the same key from coexisting in tenant scope (good — first line
  // of defense). The guard covers the cross-row case where a previous
  // proposal with the same key has already been executed, e.g., an
  // admin re-uploads a command with the same external idempotency
  // key. In that path the second proposal must short-circuit rather
  // than re-mutate.
  describe('idempotency short-circuit', () => {
    it('short-circuits when a prior executed proposal shares the idempotencyKey', async () => {
      const { IdempotencyGuard } = await import('../../src/proposals/execution/idempotency');
      const repo = new InMemoryProposalRepository();
      const handlers = createExecutionHandlerRegistry();
      const guard = new IdempotencyGuard(repo);
      const executor = new ProposalExecutor(handlers, repo, guard);

      // First proposal executes cleanly under idem-key-42.
      const first = makeApprovedProposal({ idempotencyKey: 'idem-key-42' });
      await repo.create(first);
      const firstRun = await executor.execute(first, context);
      expect(firstRun.result.success).toBe(true);
      const priorEntityId = firstRun.result.resultEntityId;
      expect(priorEntityId).toBeDefined();

      // Admin re-submits a fresh proposal row with the same external
      // idempotency key but a different proposal id (e.g., replaying
      // a command-log replay). The repo allows creation only because
      // the key uniqueness check matches against live rows — the
      // first proposal has already been transitioned to 'executed',
      // so the dedup path is the guard's job.
      //
      // Since InMemoryProposalRepository blocks on (tenant, key)
      // regardless of status, we exercise the guard directly. In Pg
      // the uniqueness is similarly (tenant, key), so the same
      // concrete path requires a follow-up: the guard is still
      // valuable when keys are per-run (voice recording id) rather
      // than per-command.
      const result = await guard.checkAndExecute(first, async () => ({
        success: true,
        resultEntityId: 'should-not-be-called',
      }));
      expect(result.alreadyExecuted).toBe(true);
      expect(result.result.resultEntityId).toBe(priorEntityId);
    });

    it('runs the executeFn when no prior executed proposal matches the key', async () => {
      const { IdempotencyGuard } = await import('../../src/proposals/execution/idempotency');
      const repo = new InMemoryProposalRepository();
      const guard = new IdempotencyGuard(repo);

      const proposal = makeApprovedProposal({ idempotencyKey: 'fresh-key' });
      const outcome = await guard.checkAndExecute(proposal, async () => ({
        success: true,
        resultEntityId: 'entity-new',
      }));
      expect(outcome.alreadyExecuted).toBe(false);
      expect(outcome.result.resultEntityId).toBe('entity-new');
    });

    it('is a passthrough when the proposal has no idempotencyKey', async () => {
      const { IdempotencyGuard } = await import('../../src/proposals/execution/idempotency');
      const repo = new InMemoryProposalRepository();
      const guard = new IdempotencyGuard(repo);

      const proposal = makeApprovedProposal(); // no idempotencyKey
      const outcome = await guard.checkAndExecute(proposal, async () => ({
        success: true,
        resultEntityId: 'entity-x',
      }));
      expect(outcome.alreadyExecuted).toBe(false);
      expect(outcome.result.resultEntityId).toBe('entity-x');
    });
  });
});
