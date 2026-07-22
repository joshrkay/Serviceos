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

import { ProposalRepository, Proposal } from '../proposals/proposal';
import { ProposalExecutor } from '../proposals/execution/executor';
import { UNDO_WINDOW_MS } from '../proposals/lifecycle';
import { Logger } from '../logging/logger';
import { instrument } from '../monitoring/instrumentation';

export interface ExecutionWorkerDeps {
  proposalRepo: ProposalRepository;
  executor: ProposalExecutor;
  logger: Logger;
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
      deps.logger.warn('Execution sweep: recovered stale executing proposals', recovered);
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
        executedBy:
          proposal.proposalType === 'adopt_entity_alias'
            ? proposal.executedBy ?? proposal.createdBy
            : proposal.createdBy,
      });
      executed++;
      deps.logger.info('Execution sweep: proposal executed', {
        proposalId: proposal.id,
        tenantId: proposal.tenantId,
        proposalType: proposal.proposalType,
      });
    } catch (err) {
      failed++;
      deps.logger.warn('Execution sweep: proposal execution failed', {
        proposalId: proposal.id,
        tenantId: proposal.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
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
