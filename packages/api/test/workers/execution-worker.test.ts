/**
 * Auto-delivery worker tests — verifies the sweep that runs approved
 * proposals past the 5-second undo window through the executor.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProposal,
  InMemoryProposalRepository,
  CreateProposalInput,
  Proposal,
  staleExecutionTimeoutMessage,
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
        // Matches logProposalEvent / executionAuditInput's convention of
        // always including the post-transition status.
        status: 'execution_failed',
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

  /**
   * Follow-up to PR #815 — the timeout event above was emitted with the
   * GENERIC timeout wording only, because the underlying cause was thrown,
   * caught, logged, and dropped: the per-proposal `catch` around
   * `executor.execute` recorded `err.message` in a log line and nowhere else.
   * An operator debugging a stuck proposal in the inbox (or
   * `evaluateSilentExecutionFailures`) then saw "timed out" with no reason.
   *
   * The caught error is now persisted into the SAME `execution_error` concept
   * PR #815 already established (never a parallel field), which
   * `resetStaleExecuting` already COALESCEs rather than clobbers — so the real
   * cause survives to the terminal write and rides the timeout audit event.
   */
  describe('stale-executing timeout carries the real cause', () => {
    /** Executor stub that always throws — stands in for a handler blowing up. */
    function throwingDeps(
      repo: InMemoryProposalRepository,
      auditRepo: AuditRepository,
      thrown: unknown,
      onExecute?: (proposal: Proposal) => Promise<void>,
    ): ExecutionWorkerDeps {
      const executor = {
        execute: async (proposal: Proposal) => {
          await onExecute?.(proposal);
          throw thrown;
        },
      } as unknown as ExecutionWorkerDeps['executor'];
      return { proposalRepo: repo, executor, logger, auditRepo };
    }

    async function seedReady(idempotencyKey: string): Promise<Proposal> {
      let proposal = createProposal({ ...baseInput, idempotencyKey });
      proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
      proposal = transitionProposal(proposal, 'approved', 'user-1');
      proposal = { ...proposal, approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100) };
      await repo.create(proposal);
      return proposal;
    }

    it('persists the caught execution error onto the still-executing proposal', async () => {
      const proposal = await seedReady('cause-persisted');
      const auditRepo = new InMemoryAuditRepository();

      const { failed } = await runExecutionSweep(
        throwingDeps(repo, auditRepo, new Error('handler exploded: column "foo" does not exist')),
      );
      expect(failed).toBe(1);

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      // Still claimed — the throw happened before any status transition.
      expect(updated!.status).toBe('executing');
      expect(updated!.executionError).toBe('handler exploded: column "foo" does not exist');
    });

    it('the proposal.execution_timed_out event carries the persisted cause, not only the generic timeout wording', async () => {
      const proposal = await seedReady('cause-on-audit-event');
      const auditRepo = new InMemoryAuditRepository();

      // Sweep 1 — claim, throw, record the cause.
      await runExecutionSweep(throwingDeps(repo, auditRepo, new Error('SMTP relay refused the message')));
      // Sweep 2 — staleMinutes/maxRetries at 0 so the claimed row terminalizes
      // on this very tick instead of waiting out the real 10-minute window.
      await runExecutionSweep({
        ...throwingDeps(repo, auditRepo, new Error('unused — nothing is ready any more')),
        staleMinutes: 0,
        maxRetries: 0,
      });

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      expect(updated!.status).toBe('execution_failed');
      // COALESCE semantics: the real cause survives the terminal write.
      expect(updated!.executionError).toBe('SMTP relay refused the message');

      const events = (await auditRepo.findByEntity(proposal.tenantId, 'proposal', proposal.id)).filter(
        (e) => e.eventType === 'proposal.execution_timed_out',
      );
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        proposalType: 'create_customer',
        status: 'execution_failed',
        executionError: 'SMTP relay refused the message',
      });
    });

    it('still records the synthesized timeout reason when no cause was ever captured', async () => {
      // A proposal that went stale without this worker ever catching a throw
      // (a crashed worker, say) has no real cause to report — the event must
      // carry the synthesized reason rather than an empty/absent field.
      let proposal = createProposal({ ...baseInput, idempotencyKey: 'no-cause-captured' });
      proposal = transitionProposal(proposal, 'ready_for_review', 'user-1');
      proposal = transitionProposal(proposal, 'approved', 'user-1');
      proposal = {
        ...proposal,
        status: 'executing',
        claimedAt: new Date(Date.now() - 11 * 60 * 1000),
        claimedBy: 'execution-worker',
        executionRetryCount: 3,
        approvedAt: new Date(Date.now() - UNDO_WINDOW_MS - 100),
      };
      await repo.create(proposal);

      const auditRepo = new InMemoryAuditRepository();
      await runExecutionSweep(makeDeps(repo, auditRepo));

      const events = (await auditRepo.findByEntity(proposal.tenantId, 'proposal', proposal.id)).filter(
        (e) => e.eventType === 'proposal.execution_timed_out',
      );
      expect(events).toHaveLength(1);
      expect(events[0].metadata.executionError).toBe(staleExecutionTimeoutMessage(10, 3));
    });

    it('redacts secrets and PII out of the cause before it reaches the row or the audit event', async () => {
      const proposal = await seedReady('cause-redacted');
      const auditRepo = new InMemoryAuditRepository();

      await runExecutionSweep(
        throwingDeps(
          repo,
          auditRepo,
          new Error(
            'POST https://api.example.com/send?api_key=live_9f8e7d6c5b failed for ' +
              'jane.doe@example.com (555-123-4567) — Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
          ),
        ),
      );

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      const recorded = updated!.executionError!;
      expect(recorded).not.toContain('live_9f8e7d6c5b');
      expect(recorded).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc.def');
      expect(recorded).not.toContain('jane.doe@example.com');
      expect(recorded).not.toContain('555-123-4567');
      // Still debuggable — the non-sensitive shape of the failure survives.
      expect(recorded).toContain('api.example.com');
    });

    it('does not stamp a cause on a proposal the executor already moved out of executing', async () => {
      // Mirrors the CHAIN_PARENT_PENDING path: the executor deliberately puts
      // the row back to 'approved' for the next tick and THEN throws. That is
      // a routine retry, not a failure — writing an execution_error there
      // would show a scary reason on GET /api/proposals for a proposal that
      // is simply waiting on its chain sibling.
      const proposal = await seedReady('cause-not-stamped-when-requeued');
      const auditRepo = new InMemoryAuditRepository();

      await runExecutionSweep(
        throwingDeps(repo, auditRepo, new Error('CHAIN_PARENT_PENDING'), async (claimed) => {
          await repo.updateStatus(claimed.tenantId, claimed.id, 'approved', {
            approvedAt: claimed.approvedAt,
          });
        }),
      );

      const updated = await repo.findById(proposal.tenantId, proposal.id);
      expect(updated!.status).toBe('approved');
      expect(updated!.executionError).toBeUndefined();
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
