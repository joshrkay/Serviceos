import React from 'react';
import { Proposal, ProposalStatus, Role } from '../../types/conversation';

export interface ProposalCardProps {
  proposal: Proposal;
  userRole: Role;
  onApprove?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
  onOpenDetail?: (proposalId: string) => void;
}

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function canApproveProposal(role: Role): boolean {
  return role === 'owner' || role === 'dispatcher';
}

export function ProposalCard({
  proposal,
  userRole,
  onApprove,
  onReject,
  onOpenDetail,
}: ProposalCardProps) {
  const canApprove = canApproveProposal(userRole);
  const isPending = proposal.status === 'pending';

  return (
    <div className="proposal-card" data-testid="proposal-card" data-status={proposal.status}>
      <div className="proposal-header">
        <span className="proposal-type" data-testid="proposal-type">
          {proposal.type}
        </span>
        <span className="proposal-status-badge" data-testid="proposal-status">
          {STATUS_LABELS[proposal.status]}
        </span>
      </div>

      <div className="proposal-summary" data-testid="proposal-summary">
        {proposal.summary}
      </div>

      <div className="proposal-actions" data-testid="proposal-actions">
        {canApprove && isPending && onApprove && (
          <button
            className="proposal-approve-btn"
            data-testid="proposal-approve-button"
            onClick={() => onApprove(proposal.id)}
          >
            Approve
          </button>
        )}
        {canApprove && isPending && onReject && (
          <button
            className="proposal-reject-btn"
            data-testid="proposal-reject-button"
            onClick={() => onReject(proposal.id)}
          >
            Reject
          </button>
        )}
        {onOpenDetail && (
          <button
            className="proposal-detail-btn"
            data-testid="proposal-detail-button"
            onClick={() => onOpenDetail(proposal.id)}
          >
            View Details
          </button>
        )}
      </div>
    </div>
  );
}
