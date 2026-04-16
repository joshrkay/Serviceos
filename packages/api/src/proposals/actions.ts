import { Proposal, ProposalRepository } from './proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from './lifecycle';
import { validateProposalPayload } from './contracts';
import { Role, hasPermission } from '../auth/rbac';
import { AppError, ForbiddenError, ValidationError, NotFoundError } from '../shared/errors';

export async function approveProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const transitioned = transitionProposal(proposal, 'approved', actorId);

  // D9 undo window: stamp `approvedAt` on the persisted row so the
  // executor and undoProposal can agree on when the window opened.
  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'approved', {
    approvedAt: transitioned.approvedAt,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  return updated;
}

/**
 * Decision 9 — 5-second undo window.
 *
 * Reverse an approval that was made in the last UNDO_WINDOW_MS.
 * Transitions an approved proposal to 'undone' (terminal). After the
 * window passes, undo fails — the only way to "undo" then is to
 * reverse the underlying entity via a new proposal.
 */
export async function undoProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    // Same permission as approve — if you can approve you can undo.
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'approved') {
    throw new ValidationError(
      `Cannot undo proposal in '${proposal.status}' status — only 'approved' proposals can be undone`
    );
  }

  if (!isInUndoWindow(proposal)) {
    throw new AppError(
      'UNDO_WINDOW_CLOSED',
      `Undo window has closed (${UNDO_WINDOW_MS}ms). To reverse the action, create a new proposal.`,
      409
    );
  }

  const transitioned = transitionProposal(proposal, 'undone', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'undone', {
    undoneAt: transitioned.undoneAt,
    undoneBy: transitioned.undoneBy,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  return updated;
}

export async function rejectProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  reason: string,
  details?: string
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const transitioned = transitionProposal(proposal, 'rejected', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'rejected', {
    rejectionReason: reason,
    rejectionDetails: details,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  return updated;
}

export async function editProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  edits: Record<string, unknown>
): Promise<{ proposal: Proposal; editedFields: string[] }> {
  if (!hasPermission(actorRole, 'proposals:edit')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') {
    throw new ValidationError(`Cannot edit proposal in '${proposal.status}' status`);
  }

  const updatedPayload = { ...proposal.payload, ...edits };

  const validation = validateProposalPayload(proposal.proposalType, updatedPayload);
  if (!validation.valid) {
    throw new ValidationError('Invalid payload after edit', { errors: validation.errors });
  }

  const editedFields = Object.keys(edits).filter(
    (key) => JSON.stringify(proposal.payload[key]) !== JSON.stringify(edits[key])
  );

  const updated = await proposalRepo.update(tenantId, proposalId, {
    payload: updatedPayload,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  return { proposal: updated, editedFields };
}
