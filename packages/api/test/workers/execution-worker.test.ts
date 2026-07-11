/**
 * Auto-delivery worker tests — verifies the sweep that runs approved
 * proposals past the 5-second undo window through the executor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
} from '../../src/proposals/proposal';
import { transitionProposal, UNDO_WINDOW_MS } from '../../src/proposals/lifecycle';
import { ProposalExecutor } from '../../src/proposals/execution/executor';
import { IdempotencyGuard } from '../../src/proposals/execution/idempotency';
import { InMemoryProposalExecutionRepository } from '../../src/proposals/proposal-execution';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { createExecutionHandlerRegistry } from '../../src/proposals/execution/handlers';
import { runExecutionSweep, ExecutionWorkerDeps } from '../../src/workers/execution-worker';
import { createLogger } from '../../src/logging/logger';

const baseInput: CreateProposalInput = {
  tenantId: 'tenant-1',
  proposalType: 'create_customer',
  payload: { name: 'John Doe' },
  summary: 'Create customer',
  createdBy: 'user-1',
};

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

function makeDeps(repo: InMemoryProposalRepository): ExecutionWorkerDeps {
  const handlers = createExecutionHandlerRegistry();
  const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), repo);
  const executor = new ProposalExecutor(handlers, repo, guard, new InMemoryAuditRepository());
  return { proposalRepo: repo, executor, logger };
}

describe('Execution auto-delivery worker (D9 undo window complement)', () => {
  let repo: InMemoryProposalRepository;

  beforeEach(() => {
    repo = new InMemoryProposalRepository();
  });

  it('executes a proposal whose undo window has closed', async () => {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    // Backdate past the window.
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await repo.create(proposal);

    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(1);
    expect(failed).toBe(0);

    const updated = await repo.findById('tenant-1', proposal.id);
    expect(updated!.status).toBe('executed');
  });

  it('skips a proposal still inside the undo window', async () => {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    // Fresh approval — inside the window.
    await repo.create(proposal);

    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(0);
    expect(failed).toBe(0);

    const updated = await repo.findById('tenant-1', proposal.id);
    expect(updated!.status).toBe('approved');
  });

  it('executes a historical proposal without approvedAt (backward compat)', async () => {
    let proposal = createProposal(baseInput);
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    // Remove approvedAt to simulate a pre-undo-window-slice proposal.
    proposal = { ...proposal, approvedAt: undefined };
    await repo.create(proposal);

    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(1);
    expect(failed).toBe(0);
  });

  it('handles execution failure without crashing the sweep', async () => {
    // Create a proposal with a type that has no execution handler.
    let proposal = createProposal({
      ...baseInput,
      proposalType: 'onboarding_schedule',
    });
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await repo.create(proposal);

    // Also add a normal proposal that should succeed.
    let goodProposal = createProposal({
      ...baseInput,
      idempotencyKey: 'good-one',
    });
    goodProposal = transitionProposal(goodProposal, 'ready_for_review', 'user-1');
    goodProposal = transitionProposal(goodProposal, 'approved', 'user-1');
    goodProposal = {
      ...goodProposal,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    await repo.create(goodProposal);

    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    // One fails (no handler for onboarding_schedule), one succeeds.
    expect(executed).toBe(1);
    expect(failed).toBe(1);
  });

  it('returns 0/0 when no proposals are ready', async () => {
    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(0);
    expect(failed).toBe(0);
  });

  it('claim lock prevents duplicate execution across sweeps', async () => {
    let proposal = createProposal({ ...baseInput, idempotencyKey: 'claim-lock' });
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
    await repo.create(proposal);

    const first = await runExecutionSweep(makeDeps(repo));
    const second = await runExecutionSweep(makeDeps(repo));

    expect(first.executed).toBe(1);
    expect(second.executed).toBe(0);
    const updated = await repo.findById('tenant-1', proposal.id);
    expect(updated?.status).toBe('executed');
  });

  it('ignores proposals in non-approved statuses', async () => {
    // Draft proposal — should not be picked up.
    const draft = createProposal(baseInput);
    await repo.create(draft);

    // Executed proposal — should not be picked up.
    let executedProp = createProposal({ ...baseInput, idempotencyKey: 'exec' });
    executedProp = transitionProposal(executedProp, 'ready_for_review', 'user-1');
    executedProp = transitionProposal(executedProp, 'approved', 'user-1');
    executedProp = { ...executedProp, status: 'executed' as const };
    await repo.create(executedProp);

    const { executed, failed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(0);
    expect(failed).toBe(0);
  });

  it('resets stale executing proposals and retries them', async () => {
    let proposal = createProposal({ ...baseInput, idempotencyKey: 'stale-reset' });
    proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
    proposal = transitionProposal(proposal, 'approved', 'user-1');
    proposal = {
      ...proposal,
      status: 'executing',
      claimedAt: new Date(Date.now() - 11 * 60 * 1000),
      executionRetryCount: 0,
      approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
    };
    await repo.create(proposal);

    const { executed } = await runExecutionSweep(makeDeps(repo));
    expect(executed).toBe(1);
  });
});
