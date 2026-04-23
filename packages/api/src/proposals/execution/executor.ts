import { Proposal, ProposalRepository } from '../proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from '../lifecycle';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { IdempotencyGuard } from './idempotency';
import { ProposalType } from '../proposal';
import { AppError } from '../../shared/errors';

export class ProposalExecutor {
  /**
   * Optional idempotency guard. When supplied, proposals with an
   * `idempotencyKey` are checked against prior executed proposals
   * before the handler runs — if a previous success is found, the
   * executor short-circuits with that same `resultEntityId` instead
   * of double-creating entities. Protects against queue redelivery
   * and operator re-approval after a network blip.
   */
  private readonly idempotency?: IdempotencyGuard;

  constructor(
    private readonly handlers: Map<ProposalType, ExecutionHandler>,
    private readonly proposalRepo: ProposalRepository,
    idempotency?: IdempotencyGuard
  ) {
    this.idempotency = idempotency;
  }

  async execute(
    proposal: Proposal,
    context: ExecutionContext
  ): Promise<{ proposal: Proposal; result: ExecutionResult; alreadyExecuted?: boolean }> {
    if (proposal.status !== 'approved') {
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
    if (isInUndoWindow(proposal)) {
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

    // Idempotency gate: route through the guard when present. When
    // `idempotencyKey` is absent the guard is a passthrough and runs
    // the handler directly, preserving behavior for callers that
    // haven't adopted idempotency keys yet.
    let result: ExecutionResult;
    let alreadyExecuted = false;
    if (this.idempotency) {
      const outcome = await this.idempotency.checkAndExecute(proposal, () =>
        handler.execute(proposal, context)
      );
      result = outcome.result;
      alreadyExecuted = outcome.alreadyExecuted;
    } else {
      result = await handler.execute(proposal, context);
    }

    let updatedProposal: Proposal;
    if (result.success) {
      updatedProposal = transitionProposal(proposal, 'executed', context.executedBy);
      updatedProposal.resultEntityId = result.resultEntityId;
      updatedProposal.executedAt = new Date();
      updatedProposal.executedBy = context.executedBy;
    } else {
      updatedProposal = transitionProposal(proposal, 'execution_failed', context.executedBy);
    }

    // If the idempotency guard short-circuited (alreadyExecuted), the
    // DB row is already in 'executed' state; avoid re-writing status
    // so we don't stomp on executedAt/executedBy from the original
    // run. Return the prior proposal as-is to the caller.
    if (!alreadyExecuted) {
      await this.proposalRepo.updateStatus(
        updatedProposal.tenantId,
        updatedProposal.id,
        updatedProposal.status,
        {
          resultEntityId: updatedProposal.resultEntityId,
          executedAt: updatedProposal.executedAt,
          executedBy: updatedProposal.executedBy,
        }
      );
    }

    return { proposal: updatedProposal, result, alreadyExecuted };
  }
}
