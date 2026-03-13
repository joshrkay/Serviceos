import { Proposal, ProposalRepository } from './proposal';
import { ValidationError } from '../shared/errors';

export type RejectionReason = 'wrong_entity' | 'missing_info' | 'wrong_pricing' | 'wrong_wording' | 'duplicate_action' | 'other';

export interface RejectionRecord {
  proposalId: string;
  tenantId: string;
  reason: RejectionReason;
  details?: string;
  proposalType: string;
  rejectedBy: string;
  rejectedAt: Date;
}

export const REJECTION_REASONS: RejectionReason[] = [
  'wrong_entity',
  'missing_info',
  'wrong_pricing',
  'wrong_wording',
  'duplicate_action',
  'other',
];

export function isValidRejectionReason(reason: string): reason is RejectionReason {
  return REJECTION_REASONS.includes(reason as RejectionReason);
}

export function recordRejection(
  proposal: Proposal,
  reason: RejectionReason,
  details: string | undefined,
  actorId: string
): RejectionRecord {
  if (!isValidRejectionReason(reason)) {
    throw new ValidationError(`Invalid rejection reason: ${reason}`);
  }

  return {
    proposalId: proposal.id,
    tenantId: proposal.tenantId,
    reason,
    details,
    proposalType: proposal.proposalType,
    rejectedBy: actorId,
    rejectedAt: new Date(),
  };
}

export async function getRejectionSignals(
  proposalRepo: ProposalRepository,
  tenantId: string,
  taskType?: string
): Promise<{ reason: RejectionReason; count: number }[]> {
  const rejected = await proposalRepo.findByStatus(tenantId, 'rejected');

  const filtered = taskType
    ? rejected.filter((p) => p.proposalType === taskType)
    : rejected;

  const counts = new Map<RejectionReason, number>();

  for (const proposal of filtered) {
    const reason = proposal.rejectionReason;
    if (reason && isValidRejectionReason(reason)) {
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export function getTopRejectionReason(
  signals: { reason: RejectionReason; count: number }[]
): RejectionReason | null {
  if (signals.length === 0) return null;
  return signals[0].reason;
}
