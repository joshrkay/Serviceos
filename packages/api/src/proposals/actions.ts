import { Proposal, ProposalRepository } from './proposal';
import { transitionProposal } from './lifecycle';
import { validateProposalPayload } from './contracts';
import { Role, hasPermission } from '../auth/rbac';
import { ForbiddenError, ValidationError, NotFoundError } from '../shared/errors';

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

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'approved');
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
  if (!hasPermission(actorRole, 'proposals:view')) {
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
  if (!hasPermission(actorRole, 'proposals:approve')) {
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
