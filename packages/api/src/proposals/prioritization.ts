import { Proposal, ProposalType } from './proposal';

export interface PrioritizedProposal {
  proposal: Proposal;
  urgency: 'critical' | 'high' | 'normal' | 'low';
  reason?: string;
}

const TYPE_PRIORITY: Record<ProposalType, number> = {
  draft_estimate: 0,
  draft_invoice: 1,
  update_estimate: 1,
  create_appointment: 2,
  create_job: 3,
  create_customer: 4,
  update_customer: 5,
};

export function getUrgency(proposal: Proposal): { urgency: PrioritizedProposal['urgency']; reason: string } {
  if (proposal.expiresAt) {
    const now = new Date();
    const twoHoursMs = 2 * 60 * 60 * 1000;
    const timeUntilExpiry = proposal.expiresAt.getTime() - now.getTime();
    if (timeUntilExpiry <= twoHoursMs) {
      return { urgency: 'critical', reason: 'Expiring within 2 hours' };
    }
  }

  if (proposal.confidenceScore !== undefined && proposal.confidenceScore < 0.5) {
    return { urgency: 'high', reason: 'Low confidence score' };
  }

  if (proposal.status === 'ready_for_review') {
    return { urgency: 'normal', reason: 'Awaiting review' };
  }

  return { urgency: 'low', reason: 'Standard priority' };
}

const URGENCY_ORDER: Record<PrioritizedProposal['urgency'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function prioritizeProposals(proposals: Proposal[]): PrioritizedProposal[] {
  const prioritized: PrioritizedProposal[] = proposals.map((proposal) => {
    const { urgency, reason } = getUrgency(proposal);
    return { proposal, urgency, reason };
  });

  prioritized.sort((a, b) => {
    const urgencyDiff = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (urgencyDiff !== 0) return urgencyDiff;

    // Within same urgency, oldest first (by createdAt)
    const ageDiff = a.proposal.createdAt.getTime() - b.proposal.createdAt.getTime();
    if (ageDiff !== 0) return ageDiff;

    // Tie-break by type priority
    const typePriorityA = TYPE_PRIORITY[a.proposal.proposalType] ?? 99;
    const typePriorityB = TYPE_PRIORITY[b.proposal.proposalType] ?? 99;
    return typePriorityA - typePriorityB;
  });

  return prioritized;
}
