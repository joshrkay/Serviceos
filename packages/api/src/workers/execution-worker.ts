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

export interface ExecutionWorkerDeps {
  proposalRepo: ProposalRepository;
  executor: ProposalExecutor;
  logger: Logger;
  windowMs?: number;
}

export async function runExecutionSweep(deps: ExecutionWorkerDeps): Promise<{
  executed: number;
  failed: number;
}> {
  const windowMs = deps.windowMs ?? UNDO_WINDOW_MS;
  let executed = 0;
  let failed = 0;

  let ready: Proposal[];
  try {
    ready = await deps.proposalRepo.findReadyForExecution(windowMs);
  } catch (err) {
    deps.logger.error('Execution sweep: failed to query ready proposals', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { executed: 0, failed: 0 };
  }

  for (const proposal of ready) {
    try {
      await deps.executor.execute(proposal, {
        tenantId: proposal.tenantId,
        executedBy: proposal.createdBy,
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
