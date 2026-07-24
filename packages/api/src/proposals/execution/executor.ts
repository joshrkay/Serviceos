import { Proposal, ProposalRepository } from '../proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from '../lifecycle';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { IdempotencyGuard, withResolvedIdempotencyKey } from './idempotency';
import { ProposalType } from '../proposal';
import { AppError } from '../../shared/errors';
import { ProposalExecutionRepository } from '../proposal-execution';
import { resolveChainReferences } from './chain-resolution';
import { isProposalTypeAllowedOnSurface, resolveSurface } from '../surface';
import { createLogger } from '../../logging/logger';
import { executeAudited } from '../../commands/command-runner';
import { AuditEventInput, AuditRepository } from '../../audit/audit';

const logger = createLogger({
  service: 'proposals.execution.executor',
  environment: process.env.NODE_ENV || 'development',
});

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
    /**
     * WS11 — REQUIRED. Every execution outcome writes a
     * `proposal.executed` / `proposal.execution_failed` audit event in the
     * SAME transaction as the state change (via executeAudited), so an
     * agent-driven state change cannot commit without its audit row. Required
     * at the constructor (not optional) so the invariant is enforced at
     * compile time for every executor wiring, tests included.
     */
    private readonly auditRepo: AuditRepository,
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

    // RIVET P4 / invariant I6 — surface enforcement at the EXECUTION boundary,
    // not at intent-parse time. A proposal stamped with the S1 (inbound,
    // unauthenticated caller) surface may only execute if its type is on the
    // S1 allowlist. This is defense-in-depth behind the creation-time
    // allowlist in the voice-turn processor: even if a mis-stamped or
    // maliciously-shaped S1 proposal reaches an operator's approval queue and
    // is approved, an S2-only op (send invoice, take payment, …) still cannot
    // execute from an S1 session. An absent/S2/S3 surface is unrestricted, so
    // every existing proposal and the operator/in-app paths are unaffected.
    const surface = resolveSurface(
      proposal.sourceContext as Record<string, unknown> | undefined,
      proposal.createdBy,
    );
    if (!isProposalTypeAllowedOnSurface(surface, proposal.proposalType)) {
      logger.error('Blocked cross-surface proposal execution', {
        tenantId: proposal.tenantId,
        proposalId: proposal.id,
        proposalType: proposal.proposalType,
        surface,
      });
      throw new AppError(
        'SURFACE_VIOLATION',
        `Proposal type '${proposal.proposalType}' is not permitted on surface '${surface}' ` +
          `(inbound caller sessions may only reach the S1 allowlist).`,
        403
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
      // WS11: this is an execution outcome, so it gets the same
      // `proposal.execution_failed` audit event as a handler failure. No lock
      // connection exists yet at this point, so executeAudited runs
      // untransacted (client: null) — the audit is still mandatory and
      // unswallowed.
      const failed = transitionProposal(proposal, 'execution_failed', context.executedBy);
      const cascadeResult: ExecutionResult = {
        success: false,
        error: 'chain_dependency_failed',
      };
      await executeAudited({
        client: null,
        tenantId: failed.tenantId,
        auditRepo: this.auditRepo,
        stateChange: () =>
          this.proposalRepo.updateStatus(failed.tenantId, failed.id, failed.status, {
            rejectionDetails: `Blocked by failed chain dependency '${chainResolution.parentId}'`,
          }),
        audit: () => executionAuditInput(failed, context, cascadeResult),
      });
      return { proposal: failed, result: cascadeResult };
    }

    // Idempotency gate (§11 H1). Keys default to `proposal-run:{tenant}:{id}`
    // when callers omit `idempotencyKey`, so every execution is lockable.
    const keyedProposal = withResolvedIdempotencyKey(executableProposal);
    let executionId: string | undefined;
    let executionRecordedInGuard = false;
    // Set inside the transactional core on a FIRST (non-short-circuited) run;
    // stays undefined when the idempotency guard short-circuits.
    let txUpdatedProposal: Proposal | undefined;

    // DATA-31: the handler's domain mutation, the idempotency record, and the
    // proposal status transition used to be three writes on three connections
    // with no shared transaction (this is a BACKGROUND sweep, so
    // PgBaseRepository.withTenantTransaction found no ambient request tx and
    // landed each call on its own connection). A crash after the mutation
    // committed but before updateStatus('executed') stranded the proposal at
    // 'approved' — and, for handlers that don't self-guard on target state, a
    // retry could re-run the mutation. We now run all three — plus the WS11
    // execution-outcome audit event — inside ONE transaction on the advisory
    // lock's OWN connection, so they commit all-or-nothing while the lock is
    // still held, and only unlock after COMMIT.
    const outcome = await this.idempotency.checkAndExecute(keyedProposal, async (lockClient) => {
      // Shared closure: given the handler's result, compute the post-execution
      // proposal view, write the idempotency marker (on success), and transition
      // the status. Factored out so it isn't duplicated across the DB-only and
      // external-I/O branches below. Sets the outer-scope `executionId`,
      // `executionRecordedInGuard`, and `txUpdatedProposal`. Callers decide the
      // transaction boundary this runs in (see the three paths below).
      const recordAndTransition = async (handlerResult: ExecutionResult): Promise<void> => {
        let updated: Proposal;
        if (handlerResult.success) {
          updated = transitionProposal(proposal, 'executed', context.executedBy);
          updated.resultEntityId = handlerResult.resultEntityId;
          updated.executedAt = new Date();
          updated.executedBy = context.executedBy;
        } else {
          updated = transitionProposal(proposal, 'execution_failed', context.executedBy);
        }

        // Critical race fix (§11 H1): write the idempotency marker while we still
        // hold the advisory lock. A second concurrent caller can't acquire the
        // lock until we COMMIT + unlock, so it will see this marker and
        // short-circuit instead of re-running.
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

        // Status transition. In the DB-only path this commits atomically with the
        // domain mutation and the idempotency record (DATA-31). In the
        // external-I/O path the handler's domain writes have already committed on
        // their own connections; only this marker + status write share a
        // transaction, so a failure here does NOT unwind the already-sent side
        // effect (mirrors pre-DATA-31 semantics for those handlers).
        await this.proposalRepo.updateStatus(
          updated.tenantId,
          updated.id,
          updated.status,
          {
            resultEntityId: updated.resultEntityId,
            executedAt: updated.executedAt,
            executedBy: updated.executedBy,
            // QA-2026-06-05: persist WHY execution failed. Handlers return a
            // reason in result.error, but it was dropped — execution_failed
            // rows had execution_error NULL and were undebuggable (live: every
            // voice create_customer failed silently on a payload-shape
            // mismatch for weeks of QA archaeology).
            ...(handlerResult.success
              ? {}
              : { executionError: handlerResult.error ?? 'unknown execution failure' }),
          }
        );

        txUpdatedProposal = updated;
      };

      // PR #666 (Gemini HIGH): branch on whether the handler performs synchronous
      // external network I/O inside execute().
      const performsExternalIo = handler.performsExternalIo === true;

      if (lockClient && !performsExternalIo) {
        // Path A — DB-only handler with a locked connection: UNCHANGED DATA-31
        // behavior, now with the WS11 audit event in the SAME unit. Run
        // handler.execute() + recordExecution + updateStatus + the
        // execution-outcome audit insert all inside ONE tenant-scoped
        // transaction on the advisory lock's own connection, so they commit
        // all-or-nothing while the lock is held. If anything throws before
        // COMMIT — including the audit insert — the whole unit rolls back: the
        // proposal stays 'approved', the mutation is invisible, and no
        // idempotency marker survives, so a retry re-executes cleanly.
        return executeAudited({
          client: lockClient,
          tenantId: keyedProposal.tenantId,
          auditRepo: this.auditRepo,
          stateChange: async () => {
            const handlerResult = await handler.execute(keyedProposal, context);
            await recordAndTransition(handlerResult);
            return handlerResult;
          },
          // txUpdatedProposal is set by recordAndTransition before the audit
          // callback runs, so the event records the post-transition status.
          audit: (handlerResult) =>
            executionAuditInput(txUpdatedProposal!, context, handlerResult),
        });
      }

      // Path B — external-I/O handler with a locked connection: run
      // handler.execute() OUTSIDE the executor transaction. Its repo writes go
      // through the normal withTenantTransaction path (own connection/tx per
      // call), so they COMMIT and release their row locks BEFORE and around the
      // external send — the connection-exhaustion + long-lived-lock risk the PR
      // finding flagged is gone. THEN wrap the idempotency record + status
      // transition + audit event in a small transaction on the advisory lock's
      // own connection (still held, so idempotency serialization is preserved).
      //
      // Path C — no locked connection (no-op lock / in-memory repos,
      // single-threaded tests): identical shape, but executeAudited receives an
      // undefined client so there is no real transaction to open — everything
      // runs directly (as it did before this change), with the audit write
      // still mandatory and unswallowed.
      const handlerResult = await handler.execute(keyedProposal, context);
      await executeAudited({
        client: lockClient,
        tenantId: keyedProposal.tenantId,
        auditRepo: this.auditRepo,
        stateChange: () => recordAndTransition(handlerResult),
        audit: () => executionAuditInput(txUpdatedProposal!, context, handlerResult),
      });
      return handlerResult;
    });
    const result: ExecutionResult = outcome.result;
    const alreadyExecuted = outcome.alreadyExecuted;

    // The status transition already committed inside the transaction on a first
    // run. Recover that committed view for the post-commit consumers below; on
    // the idempotency short-circuit path the core never ran, so recompute it.
    let updatedProposal: Proposal;
    if (txUpdatedProposal) {
      updatedProposal = txUpdatedProposal;
    } else if (result.success) {
      updatedProposal = transitionProposal(proposal, 'executed', context.executedBy);
      updatedProposal.resultEntityId = result.resultEntityId;
      updatedProposal.executedAt = new Date();
      updatedProposal.executedBy = context.executedBy;
    } else {
      updatedProposal = transitionProposal(proposal, 'execution_failed', context.executedBy);
    }

    // Crash-recovery reconciliation for the idempotency short-circuit path.
    // DATA-31 closes the crash window for NEW runs (the mutation + status now
    // commit atomically), but a proposal stranded by a PRE-DATA-31 crash can
    // still arrive here: the guard matches a prior 'executed' proposal under
    // the same key while THIS row is still 'approved'. Transition it now using
    // the resolved resultEntityId so the audit trail is coherent. This is a
    // single status write with no accompanying domain mutation, so it needs no
    // transaction of its own; on a first run the write already happened inside
    // the transaction above, so we skip it here.
    if (alreadyExecuted && proposal.status === 'approved') {
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
        logger.error('proposal-executor: recordExecution failed', {
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
        logger.error('proposal-executor: onExecuted callback failed', {
          proposalId: updatedProposal.id,
          tenantId: updatedProposal.tenantId,
          error: error.message,
        });
      }
    }

    return { proposal: updatedProposal, result, alreadyExecuted };
  }
}

/**
 * WS11 — the executor's execution-outcome audit event. Fills the terminal gap
 * in the proposal lifecycle trail: actions.ts writes created/approved/
 * rejected/edited/undone via logProposalEvent, but nothing wrote
 * `proposal.executed` / `proposal.execution_failed`. Shape mirrors
 * logProposalEvent's conventions exactly (entityType 'proposal', metadata base
 * of proposalType + post-transition status, extras spread last); actorRole
 * 'system' because the background sweep — not a human — performs execution.
 */
function executionAuditInput(
  updated: Proposal,
  context: ExecutionContext,
  result: ExecutionResult,
): AuditEventInput {
  return {
    tenantId: updated.tenantId,
    actorId: context.executedBy,
    actorRole: 'system',
    eventType: result.success ? 'proposal.executed' : 'proposal.execution_failed',
    entityType: 'proposal',
    entityId: updated.id,
    metadata: {
      proposalType: updated.proposalType,
      status: updated.status,
      ...(result.success
        ? result.resultEntityId
          ? { resultEntityId: result.resultEntityId }
          : {}
        : { executionError: result.error ?? 'unknown execution failure' }),
    },
  };
}
