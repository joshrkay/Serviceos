/**
 * Auto-delivery worker — sweeps approved proposals past the undo
 * window and hands them to the executor.
 *
 * This closes the operational question the D9 undo-window slice
 * opened: "who actually kicks execution after the 5s window closes?"
 * The answer is this background sweep, running on a short interval in
 * `app.ts` alongside the existing transcription-worker poll.
 *
 * Responsibilities:
 *   - Query `proposalRepo.findReadyForExecution(UNDO_WINDOW_MS)` for
 *     approved proposals past the undo window.
 *   - Call `executor.execute(proposal, context)` on each.
 *   - Log successes and failures; never crash the process on a single
 *     proposal's failure — other proposals in the batch must still
 *     execute.
 *
 * Not responsible for: the undo-window enforcement itself (that's
 * lifecycle.ts + executor.ts), approval (actions.ts), or delayed
 * delivery semantics beyond "past the window" (a more sophisticated
 * scheduler belongs in a future slice).
 */

import { ProposalRepository, Proposal, redactedExecutionErrorCause } from '../proposals/proposal';
import { ProposalExecutor } from '../proposals/execution/executor';
import { UNDO_WINDOW_MS } from '../proposals/lifecycle';
import { Logger } from '../logging/logger';
import { instrument } from '../monitoring/instrumentation';
import { AuditRepository, createAuditEvent } from '../audit/audit';

export interface ExecutionWorkerDeps {
  proposalRepo: ProposalRepository;
  executor: ProposalExecutor;
  logger: Logger;
  /**
   * Required (WS11-style, like ProposalExecutor's own auditRepo dependency):
   * resetStaleExecuting can write a proposal straight to the terminal
   * 'execution_failed' status, bypassing executeAudited entirely — this is
   * the ONLY place that transition gets an audit event. Not optional so a
   * new wiring can't silently drop it.
   */
  auditRepo: AuditRepository;
  windowMs?: number;
  workerId?: string;
  staleMinutes?: number;
  maxRetries?: number;
}

async function runExecutionSweepInner(deps: ExecutionWorkerDeps): Promise<{
  executed: number;
  failed: number;
}> {
  const windowMs = deps.windowMs ?? UNDO_WINDOW_MS;
  const workerId = deps.workerId ?? 'execution-worker';
  const staleMinutes = deps.staleMinutes ?? 10;
  const maxRetries = deps.maxRetries ?? 3;
  let executed = 0;
  let failed = 0;

  let ready: Proposal[];
  try {
    const recovered = await deps.proposalRepo.resetStaleExecuting(staleMinutes, maxRetries);
    if (recovered.resetToApproved > 0 || recovered.movedToFailed > 0) {
      // Log only the two counts, not the whole `recovered` object — it now
      // carries `failedProposals`, and dumping that array into one log line
      // on a mass timeout would duplicate the per-proposal audit events
      // emitted just below with no added signal.
      deps.logger.warn('Execution sweep: recovered stale executing proposals', {
        resetToApproved: recovered.resetToApproved,
        movedToFailed: recovered.movedToFailed,
      });
    }
    // Follow-up: a proposal moved straight to the terminal 'execution_failed'
    // status here (maxRetries exhausted) bypassed executeAudited entirely —
    // this is the only place that transition gets an audit event.
    //
    // The event now also carries `executionError`, the row's post-write
    // reason. Earlier this path could only say "it timed out": the ORIGINAL
    // throw was caught by the per-proposal catch below, written to a log
    // line, and dropped, so an operator debugging a stuck proposal got a
    // terminal failure with no cause. That catch now records the (redacted)
    // cause into the SAME `execution_error` concept — while the row is still
    // 'executing' — and the terminal write COALESCEs rather than clobbers, so
    // a real cause survives to here. Rows that went stale without this worker
    // ever catching anything (a crashed process) still report the synthesized
    // `staleExecutionTimeoutMessage` wording. Failure-soft — an audit-write
    // failure never blocks the sweep or the status transition, which already
    // committed.
    for (const failedProposal of recovered.failedProposals) {
      try {
        await deps.auditRepo.create(
          createAuditEvent({
            tenantId: failedProposal.tenantId,
            actorId: 'system:execution-worker',
            actorRole: 'system',
            eventType: 'proposal.execution_timed_out',
            entityType: 'proposal',
            entityId: failedProposal.id,
            metadata: {
              proposalType: failedProposal.proposalType,
              // Matches logProposalEvent / executionAuditInput's convention
              // of always including the post-transition status.
              status: 'execution_failed',
              retryCount: failedProposal.retryCount,
              staleMinutes,
              maxRetries,
              // Already bounded + scrubbed by redactedExecutionErrorCause at
              // the point it was recorded (or a synthesized constant) — safe
              // to copy into an audit row verbatim.
              ...(failedProposal.executionError
                ? { executionError: failedProposal.executionError }
                : {}),
            },
          }),
        );
      } catch (err) {
        deps.logger.error(
          'Execution sweep: failed to write proposal.execution_timed_out audit event',
          {
            proposalId: failedProposal.id,
            tenantId: failedProposal.tenantId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
    ready = await deps.proposalRepo.findReadyForExecution(windowMs);
  } catch (err) {
    deps.logger.error('Execution sweep: failed to query ready proposals', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { executed: 0, failed: 0 };
  }

  for (const proposal of ready) {
    try {
      const claimed = await deps.proposalRepo.claimForExecution(proposal.id, workerId);
      if (!claimed) {
        deps.logger.info('Proposal safely claimed for execution – only one worker will act.', {
          proposalId: proposal.id,
          tenantId: proposal.tenantId,
          claimed: false,
        });
        continue;
      }
      await deps.executor.execute(claimed, {
        tenantId: proposal.tenantId,
        // `executedBy` is stamped at approval for the types where the
        // approver — not the drafter — is the human exercising authority
        // (alias adoption, config writes). Everything else attributes to the
        // drafter, which is correct for work the drafter authored.
        executedBy: proposal.executedBy ?? proposal.createdBy,
        ...(proposal.executedByRole ? { executedByRole: proposal.executedByRole } : {}),
      });
      executed++;
      deps.logger.info('Execution sweep: proposal executed', {
        proposalId: proposal.id,
        tenantId: proposal.tenantId,
        proposalType: proposal.proposalType,
      });
    } catch (err) {
      failed++;
      // Follow-up review N2 — BUILDING the cause is inside this try, not just
      // persisting it. `redactedExecutionErrorCause` reads `err.message`, and
      // a throw from that accessor (a driver error object with a lazy or
      // derived message) used to escape this catch and abandon the rest of
      // the loop — defeating the failure-soft promise stated just below.
      try {
        const cause = redactedExecutionErrorCause(err);
        // N3 — this log line carries the REDACTED cause, not the raw
        // `err.message` it used to. Deliberate: the message can quote a
        // customer contact or a credential, and log sinks are a wider
        // audience than the `execution_error` column. The scrub keeps the
        // non-sensitive shape of the failure (host, driver code, SQLSTATE),
        // so the line stays as debuggable as it needs to be.
        deps.logger.warn('Execution sweep: proposal execution failed', {
          proposalId: proposal.id,
          tenantId: proposal.tenantId,
          error: cause,
        });
        // Persist WHY. Without this the cause lived only in this log line: the
        // row stayed claimed in 'executing' until resetStaleExecuting
        // terminalized it, and both `GET /api/proposals` and the
        // `proposal.execution_timed_out` audit event could then only say
        // "timed out". Same `execution_error` concept the terminal write
        // already uses — never a parallel field — and that write COALESCEs,
        // so what is recorded here is what survives.
        //
        // Conditional on the row still being 'executing' (updateStatusIf, one
        // atomic statement, self-transition — status is unchanged, only the
        // reason is written):
        //   - CHAIN_PARENT_PENDING puts the row back to 'approved' BEFORE
        //     throwing. That is a routine "retry next tick", not a failure,
        //     and stamping a reason would show a scary error on a proposal
        //     that is merely waiting for its chain sibling.
        //   - a handler that terminalized itself already recorded its own,
        //     better-worded reason; the precondition misses and leaves it.
        await deps.proposalRepo.updateStatusIf(
          proposal.tenantId,
          proposal.id,
          ['executing'],
          'executing',
          { executionError: cause },
        );
      } catch (recordErr) {
        // Failure-soft: nothing in this handler — building the cause, logging
        // it, or writing it — may turn one proposal's failure into the whole
        // sweep's. `failed` is already counted, so the sweep's return value
        // stays honest even when the reason could not be recorded.
        deps.logger.error('Execution sweep: failed to record the cause of a failed execution', {
          proposalId: proposal.id,
          tenantId: proposal.tenantId,
          error: recordErr instanceof Error ? recordErr.message : String(recordErr),
        });
      }
    }
  }

  return { executed, failed };
}

/**
 * §11 H3: Wrapped with instrument() so an unexpected throw in the sweep
 * (vs. per-proposal failures, which are already caught and logged inline)
 * is tagged `path=execution-worker` and captured to Sentry before the
 * error rethrows. The sweep operates over many tenants per tick, so
 * tenant_id is not extractable at this level.
 */
export const runExecutionSweep = instrument(runExecutionSweepInner, {
  path: 'execution-worker',
});
