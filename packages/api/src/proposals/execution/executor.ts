import { Proposal, ProposalRepository } from '../proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from '../lifecycle';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { IdempotencyGuard, withResolvedIdempotencyKey } from './idempotency';
import { ProposalType } from '../proposal';
import { AppError } from '../../shared/errors';
import { ProposalExecutionRepository } from '../proposal-execution';
import { resolveChainReferences } from './chain-resolution';

/**
 * Fired after a proposal completes execution (success or failure).
 * Phase 4a-1 wires this to enqueue the proposal-correction-worker so
 * the dispatcher edit delta gets diffed and embedded into the RAG
 * corpus. Failure-soft: callback errors are logged but never surface
 * as execution errors — the proposal is already executed by the time
 * we get here.
 */
export interface ProposalExecutionEvent {
  tenantId: string;
  proposalId: string;
  /** ID of the proposal_executions row created for this run, when one was written. */
  executionId?: string;
  status: 'succeeded' | 'failed';
}

export class ProposalExecutor {
  /**
   * Idempotency guard (required, §11 H1). Proposals with an
   * `idempotencyKey` are checked against prior executed proposals
   * before the handler runs — if a previous success is found, the
   * executor short-circuits with that same `resultEntityId` instead
   * of double-creating entities. Protects against queue redelivery
   * and operator re-approval after a network blip. Proposals without
   * a key flow through as a passthrough (the guard itself handles
   * that branch), so wiring the guard is safe for every executor
   * call site.
   */
  private readonly idempotency: IdempotencyGuard;

  /**
   * Optional repository to persist a `proposal_executions` row for each
   * run. When supplied, the executor records the as-executed payload
   * alongside the immutable `proposals.payload` so the
   * proposal-correction-worker (Phase 4a-1) can diff the two and emit
   * a training chunk for the RAG corpus.
   */
  private readonly executionRepo?: ProposalExecutionRepository;

  /**
   * Optional callback fired after a successful or failed execution.
   * Wires into the proposal-correction-worker queue. Errors are logged
   * but never rethrown — the proposal is already executed.
   */
  private readonly onExecuted?: (event: ProposalExecutionEvent) => Promise<void> | void;

  constructor(
    private readonly handlers: Map<ProposalType, ExecutionHandler>,
    private readonly proposalRepo: ProposalRepository,
    idempotency: IdempotencyGuard,
    options: {
      executionRepo?: ProposalExecutionRepository;
      onExecuted?: (event: ProposalExecutionEvent) => Promise<void> | void;
    } = {}
  ) {
    this.idempotency = idempotency;
    this.executionRepo = options.executionRepo;
    this.onExecuted = options.onExecuted;
  }

  async execute(
    proposal: Proposal,
    context: ExecutionContext
  ): Promise<{ proposal: Proposal; result: ExecutionResult; alreadyExecuted?: boolean }> {
    if (proposal.status !== 'approved' && proposal.status !== 'executing') {
      throw new AppError(
        'INVALID_STATUS',
        `Proposal must be in 'approved' status to execute, but is '${proposal.status}'`,
        400
      );
    }

    // Decision 9: 5-second undo window. If the proposal was approved
    // recently AND `approvedAt` is set, refuse to execute. The
    // operator still has time to call undoProposal. Historical
    // proposals without `approvedAt` are treated as past-window
    // (backward compatible — existing tests and pre-slice approved
    // proposals execute normally).
    if (proposal.status === 'approved' && isInUndoWindow(proposal)) {
      const elapsed = Date.now() - (proposal.approvedAt?.getTime() ?? Date.now());
      const remaining = Math.max(0, UNDO_WINDOW_MS - elapsed);
      throw new AppError(
        'UNDO_WINDOW_OPEN',
        `Proposal is still in the 5-second undo window (${remaining}ms remaining). ` +
          `Retry after the window closes, or call undoProposal to cancel.`,
        409
      );
    }

    const handler = this.handlers.get(proposal.proposalType);
    if (!handler) {
      throw new AppError(
        'HANDLER_NOT_FOUND',
        `No execution handler registered for proposal type '${proposal.proposalType}'`,
        400
      );
    }

    // Multi-action chaining: resolve any symbolic reference tokens
    // (`$ref:chain[0].customerId`) against the resultEntityId of the
    // sibling this proposal depends on. `noop` for non-chained
    // proposals → behavior is unchanged.
    let executableProposal = proposal;
    const chainResolution = await resolveChainReferences(proposal, {
      proposalRepo: this.proposalRepo,
    });
    if (chainResolution.status === 'resolved') {
      executableProposal = { ...proposal, payload: chainResolution.payload };
    } else if (chainResolution.status === 'blocked') {
      if (chainResolution.reason === 'parent_pending') {
        // The dependency hasn't executed yet. The sweep claimed this row
        // (status -> 'executing') before calling us; if we just threw, it
        // would sit in 'executing' until resetStaleExecuting runs (~10
        // min) because findReadyForExecution only sees 'approved'. Return
        // it to 'approved' first so the very next sweep tick re-attempts
        // it — once the parent has executed. This is the ordering
        // guarantee for chains; it does not depend on claim order.
        if (proposal.status === 'executing') {
          await this.proposalRepo.updateStatus(
            proposal.tenantId,
            proposal.id,
            'approved',
            { approvedAt: proposal.approvedAt },
          );
        }
        throw new AppError(
          'CHAIN_PARENT_PENDING',
          `Proposal depends on chain sibling '${chainResolution.parentId}' which has not executed yet. Retrying.`,
          409
        );
      }
      // parent_failed → cascade-fail this dependent. No infinite retry.
      const failed = transitionProposal(proposal, 'execution_failed', context.executedBy);
      await this.proposalRepo.updateStatus(failed.tenantId, failed.id, failed.status, {
        rejectionDetails: `Blocked by failed chain dependency '${chainResolution.parentId}'`,
      });
      return {
        proposal: failed,
        result: { success: false, error: 'chain_dependency_failed' },
      };
    }

    // Idempotency gate (§11 H1). Keys default to `proposal-run:{tenant}:{id}`
    // when callers omit `idempotencyKey`, so every execution is lockable.
    const keyedProposal = withResolvedIdempotencyKey(executableProposal);
    let executionId: string | undefined;
    let executionRecordedInGuard = false;
    const outcome = await this.idempotency.checkAndExecute(keyedProposal, async () => {
      const handlerResult = await handler.execute(keyedProposal, context);

      // Critical race fix (§11 H1): write the idempotency marker while we still
      // hold the advisory lock. If this insert happened later (after
      // checkAndExecute returns), a second concurrent caller could acquire the
      // lock, fail to find a prior execution, and run the handler a second time.
      if (this.executionRepo && handlerResult.success) {
        const row = await this.executionRepo.recordExecution({
          tenantId: keyedProposal.tenantId,
          proposalId: keyedProposal.id,
          executedPayload: keyedProposal.payload,
          executedBy: context.executedBy,
          status: 'succeeded',
          idempotencyKey: keyedProposal.idempotencyKey,
        });
        executionId = row.id;
        executionRecordedInGuard = true;
      }

      return handlerResult;
    });
    const result: ExecutionResult = outcome.result;
    const alreadyExecuted = outcome.alreadyExecuted;

    let updatedProposal: Proposal;
    if (result.success) {
      updatedProposal = transitionProposal(proposal, 'executed', context.executedBy);
      updatedProposal.resultEntityId = result.resultEntityId;
      updatedProposal.executedAt = new Date();
      updatedProposal.executedBy = context.executedBy;
    } else {
      updatedProposal = transitionProposal(proposal, 'execution_failed', context.executedBy);
    }

    // Write the status transition. Normally this runs for every
    // execution. When the idempotency guard short-circuits
    // (`alreadyExecuted`) we usually want to leave the DB row alone
    // because it is already in 'executed' state from the prior
    // successful run — re-writing would stomp on executedAt/executedBy.
    //
    // HOWEVER: there's a subtle race. If a prior run succeeded at the
    // handler but CRASHED before it could write the status update,
    // the DB row is stuck at 'approved' while the idempotency guard
    // — which looks up by key AND status='executed' — won't find a
    // match. That means a retry would see the side effect as "not
    // done" and try to re-execute, double-firing the mutation.
    //
    // The current `alreadyExecuted` branch here is reached only when
    // the guard DID find an executed match, so the DB is consistent
    // and we can skip the write. The crash-in-the-middle path needs
    // a different fix at the guard layer (follow-up — requires
    // transactional wrapping of handler+status). For now we
    // reconcile as best we can: on the `alreadyExecuted` branch, if
    // the caller's view of the proposal is still 'approved' (e.g.,
    // because it was re-fetched after the crash), force the status
    // to 'executed' with the idempotency result so the row becomes
    // consistent the first time a retry runs cleanly.
    if (!alreadyExecuted) {
      await this.proposalRepo.updateStatus(
        updatedProposal.tenantId,
        updatedProposal.id,
        updatedProposal.status,
        {
          resultEntityId: updatedProposal.resultEntityId,
          executedAt: updatedProposal.executedAt,
          executedBy: updatedProposal.executedBy,
          // QA-2026-06-05: persist WHY execution failed. Handlers return a
          // reason in result.error, but it was dropped — execution_failed
          // rows had execution_error NULL and were undebuggable (live: every
          // voice create_customer failed silently on a payload-shape
          // mismatch for weeks of QA archaeology).
          ...(result.success ? {} : { executionError: result.error ?? 'unknown execution failure' }),
        }
      );
    } else if (proposal.status === 'approved') {
      // Defensive reconciliation: the idempotency guard matched on a
      // prior 'executed' proposal under the same key, but THIS row is
      // still 'approved' — likely the same proposal being retried
      // after a prior crash. Transition it now using the resolved
      // resultEntityId so the audit trail is coherent.
      await this.proposalRepo.updateStatus(
        proposal.tenantId,
        proposal.id,
        'executed',
        {
          resultEntityId: result.resultEntityId,
          executedAt: new Date(),
          executedBy: context.executedBy,
        }
      );
    }

    // Phase 4a-1: persist a proposal_executions row + fire the
    // onExecuted callback. We skip the row-write when the idempotency
    // guard short-circuited because the prior run already wrote one.
    // Both the insert and the callback are wrapped in their own try
    // blocks: failures are logged via console (no logger threaded yet)
    // but never rethrown — the proposal is already in 'executed' state
    // and the user-visible side effect succeeded.
    if (this.executionRepo && !alreadyExecuted && !executionRecordedInGuard) {
      try {
        const row = await this.executionRepo.recordExecution({
          tenantId: updatedProposal.tenantId,
          proposalId: updatedProposal.id,
          // Capture the as-executed payload. v1 mirrors proposal.payload
          // because we don't yet have a "dispatcher edit" surface that
          // overrides the AI draft mid-flight; when dispatcher edits land
          // they'll surface here as a different shape, and the
          // correction-worker's diff will become non-empty.
          executedPayload: updatedProposal.payload,
          executedBy: context.executedBy,
          status: result.success ? 'succeeded' : 'failed',
          errorMessage: result.success ? undefined : result.error ?? 'execution_failed',
          idempotencyKey: withResolvedIdempotencyKey(updatedProposal).idempotencyKey,
        });
        executionId = row.id;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // eslint-disable-next-line no-console
        console.error('proposal-executor: recordExecution failed', {
          proposalId: updatedProposal.id,
          tenantId: updatedProposal.tenantId,
          error: error.message,
        });
      }
    }

    // Only fire onExecuted on FIRST execution. When the idempotency guard
    // short-circuited (alreadyExecuted=true) the handler did not run — the
    // spend recorder must NOT increment again, and the proposal-correction
    // worker has nothing new to learn from a replay. Gating here is the
    // single choke-point for all consumers; no per-consumer guard needed.
    if (this.onExecuted && !alreadyExecuted) {
      try {
        await this.onExecuted({
          tenantId: updatedProposal.tenantId,
          proposalId: updatedProposal.id,
          executionId,
          status: result.success ? 'succeeded' : 'failed',
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // eslint-disable-next-line no-console
        console.error('proposal-executor: onExecuted callback failed', {
          proposalId: updatedProposal.id,
          tenantId: updatedProposal.tenantId,
          error: error.message,
        });
      }
    }

    return { proposal: updatedProposal, result, alreadyExecuted };
  }
}
