import { Proposal, ProposalRepository } from '../proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from '../lifecycle';
import { ExecutionHandler, ExecutionContext, ExecutionResult } from './handlers';
import { ProposalType } from '../proposal';
import { AppError } from '../../shared/errors';

export class ProposalExecutor {
  constructor(
    private readonly handlers: Map<ProposalType, ExecutionHandler>,
    private readonly proposalRepo: ProposalRepository
  ) {}

  async execute(
    proposal: Proposal,
    context: ExecutionContext
  ): Promise<{ proposal: Proposal; result: ExecutionResult }> {
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

    const result = await handler.execute(proposal, context);

    let updatedProposal: Proposal;
    if (result.success) {
      updatedProposal = transitionProposal(proposal, 'executed', context.executedBy);
      updatedProposal.resultEntityId = result.resultEntityId;
      updatedProposal.executedAt = new Date();
      updatedProposal.executedBy = context.executedBy;
    } else {
      updatedProposal = transitionProposal(proposal, 'execution_failed', context.executedBy);
    }

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

    return { proposal: updatedProposal, result };
  }
}
