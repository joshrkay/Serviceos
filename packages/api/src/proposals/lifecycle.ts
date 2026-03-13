import { Proposal, ProposalStatus } from './proposal';
import { ConflictError } from '../shared/errors';

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  draft: ['ready_for_review'],
  ready_for_review: ['approved', 'rejected', 'expired'],
  approved: ['executed', 'execution_failed'],
  rejected: ['draft'],
  expired: [],
  executed: [],
  execution_failed: ['draft'],
};

const TERMINAL_STATUSES: ProposalStatus[] = ['expired', 'executed'];

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function isTerminalStatus(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function transitionProposal(
  proposal: Proposal,
  targetStatus: ProposalStatus,
  actorId: string
): Proposal {
  if (!canTransition(proposal.status, targetStatus)) {
    throw new ConflictError(
      `Cannot transition proposal from '${proposal.status}' to '${targetStatus}'`
    );
  }

  return {
    ...proposal,
    status: targetStatus,
    updatedAt: new Date(),
  };
}
