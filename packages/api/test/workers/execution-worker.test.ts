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
import { InMemoryAuditRepository, AuditRepository, AuditEvent } from '../../src/audit/audit';
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

function makeDeps(
  repo: InMemoryProposalRepository,
  auditRepo: AuditRepository = new InMemoryAuditRepository(),
): ExecutionWorkerDeps {
  const handlers = createExecutionHandlerRegistry();
  const guard = new IdempotencyGuard(new InMemoryProposalExecutionRepository(), repo);
  const executor = new ProposalExecutor(handlers, repo, guard, auditRepo);
  return { proposalRepo: repo, executor, logger, auditRepo };
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
    // 'update_invoice' is only registered when createExecutionHandlerRegistry
    // is given an invoiceRepo (see handlers.ts); makeDeps() above calls it
    // with no deps at all, so this always throws HANDLER_NOT_FOUND. (Was
    // 'onboarding_schedule' — B1.19 registered a real handler for that type,
    // so it stopped throwing and started resolving with a failed
    // ExecutionResult instead, which the sweep counts as `executed`, not
    // `failed` — see the throw/catch below.)
    let proposal = createProposal({
      ...baseInput,
      proposalType: 'update_invoice',
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

  /**
   * Follow-up — a proposal claimed for execution (status 'executing') whose
   * handler throws before executeAudited ever runs (e.g. HANDLER_NOT_FOUND)
   * stays 'executing' until resetStaleExecuting retries it maxRetries times
   * and finally writes 'execution_failed' DIRECTLY — bypassing executeAudited,
   * the only place that would otherwise write the WS11 execution-outcome
   * audit event. Net: the proposal reaches a terminal failed state with no
   * audit event anywhere explaining why. The execution sweep must now emit
   * its own `proposal.execution_timed_out` event for that transition.
   */
  describe('stale-executing timeout audit event', () => {
    function findEvents(events: AuditEvent[], proposalId: string) {
      return events.filter(
        (e) => e.entityType === 'proposal' && e.entityId === proposalId && e.eventType === 'proposal.execution_timed_out',
      );
    }

    it('emits proposal.execution_timed_out when a stale executing proposal exhausts retries', async () => {
      let proposal = createProposal({ ...baseInput, proposalType: 'create_customer', idempotencyKey: 'stale-timeout' });
      proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
      proposal = transitionProposal(proposal, 'approved', 'user-1');
      proposal = {
        ...proposal,
        status: 'executing',
        claimedAt: new Date(Date.now() - 11 * 60 * 1000),
        claimedBy: 'execution-worker',
        executionRetryCount: 3, // already at maxRetries(3) — this sweep terminates it
        approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
      };
      await repo.create(proposal);

      const auditRepo = new InMemoryAuditRepository();
      await runExecutionSweep(makeDeps(repo, auditRepo));

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      expect(updated!.status).toBe('execution_failed');

      const events = await auditRepo.findByEntity(proposal.tenantId, 'proposal', proposal.id);
      const timeoutEvents = findEvents(events, proposal.id);
      expect(timeoutEvents).toHaveLength(1);
      expect(timeoutEvents[0].actorRole).toBe('system');
      expect(timeoutEvents[0].metadata).toMatchObject({
        proposalType: 'create_customer',
        retryCount: 3,
        staleMinutes: 10,
        maxRetries: 3,
      });
    });

    it('does not emit a timeout event for a proposal merely reset for another retry', async () => {
      let proposal = createProposal({ ...baseInput, idempotencyKey: 'stale-retry-no-audit' });
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

      const auditRepo = new InMemoryAuditRepository();
      await runExecutionSweep(makeDeps(repo, auditRepo));

      const events = await auditRepo.findByEntity(proposal.tenantId, 'proposal', proposal.id);
      expect(findEvents(events, proposal.id)).toHaveLength(0);
    });

    it('is failure-soft: an audit write failure does not stop the proposal from moving to execution_failed or crash the sweep', async () => {
      let proposal = createProposal({ ...baseInput, idempotencyKey: 'stale-timeout-audit-fails' });
      proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
      proposal = transitionProposal(proposal, 'approved', 'user-1');
      proposal = {
        ...proposal,
        status: 'executing',
        claimedAt: new Date(Date.now() - 11 * 60 * 1000),
        executionRetryCount: 3,
        approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
      };
      await repo.create(proposal);

      const throwingAuditRepo: AuditRepository = {
        create: async () => {
          throw new Error('audit sink unavailable');
        },
        findByEntity: async () => [],
        findByCorrelation: async () => [],
      };

      await expect(runExecutionSweep(makeDeps(repo, throwingAuditRepo))).resolves.not.toThrow();

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      expect(updated!.status).toBe('execution_failed');
    });
  });

  // Raised in PR review: the sweep attributed every type but
  // `adopt_entity_alias` to `createdBy` — the DRAFTER — and passed no role at
  // all. A technician-drafted config proposal approved by an owner therefore
  // executed as the technician, and the audit fell back to asserting 'owner'.
  // Both halves are stamped at approval precisely because this sweep runs
  // detached from that request and cannot recover them.
  describe('execution attribution', () => {
    function capturingDeps(repo: InMemoryProposalRepository) {
      const contexts: Array<Record<string, unknown>> = [];
      const executor = {
        execute: async (_p: unknown, context: Record<string, unknown>) => {
          contexts.push(context);
        },
      } as unknown as ExecutionWorkerDeps['executor'];
      return { deps: { proposalRepo: repo, executor, logger, auditRepo: new InMemoryAuditRepository() }, contexts };
    }

    async function seedApproved(overrides: Partial<CreateProposalInput> & { executedBy?: string; executedByRole?: string }) {
      const { executedBy, executedByRole, ...input } = overrides;
      let proposal = createProposal({ ...baseInput, ...input });
      proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
      proposal = transitionProposal(proposal, 'approved', 'user-1');
      proposal = {
        ...proposal,
        approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
        ...(executedBy ? { executedBy } : {}),
        ...(executedByRole ? { executedByRole } : {}),
      };
      await repo.create(proposal);
      return proposal;
    }

    it('passes the stamped approver and role, not the drafter', async () => {
      await seedApproved({
        proposalType: 'update_brand_voice',
        payload: { register: 'friendly' },
        createdBy: 'technician-7',
        executedBy: 'owner-1',
        executedByRole: 'owner',
        idempotencyKey: 'attrib-config',
      });

      const { deps, contexts } = capturingDeps(repo);
      await runExecutionSweep(deps);

      expect(contexts).toHaveLength(1);
      expect(contexts[0].executedBy).toBe('owner-1');
      expect(contexts[0].executedByRole).toBe('owner');
    });

    it('falls back to the drafter when no approver was stamped', async () => {
      await seedApproved({ createdBy: 'technician-7', idempotencyKey: 'attrib-plain' });

      const { deps, contexts } = capturingDeps(repo);
      await runExecutionSweep(deps);

      expect(contexts).toHaveLength(1);
      expect(contexts[0].executedBy).toBe('technician-7');
      expect(contexts[0].executedByRole).toBeUndefined();
    });
  });
});
