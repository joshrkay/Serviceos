import React, { useState, useCallback } from 'react';
import { Role, hasPermission } from '../../types/conversation';

export interface InvoiceProposalActionsProps {
  proposalId: string;
  userRole: Role;
  status: string;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string, reason: string) => void;
}

export function canApproveProposal(role: Role): boolean {
  return hasPermission(role, 'proposals:approve');
}

export function InvoiceProposalActions({
  proposalId,
  userRole,
  status,
  onApprove,
  onReject,
}: InvoiceProposalActionsProps) {
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');
  const canApprove = canApproveProposal(userRole);
  const isPending = status === 'pending' || status === 'draft' || status === 'ready_for_review';

  const handleApprove = useCallback(() => {
    onApprove(proposalId);
  }, [proposalId, onApprove]);

  const handleRejectClick = useCallback(() => {
    setShowRejectDialog(true);
  }, []);

  const handleRejectConfirm = useCallback(() => {
    if (rejectionReason.trim()) {
      onReject(proposalId, rejectionReason.trim());
      setShowRejectDialog(false);
      setRejectionReason('');
    }
  }, [proposalId, rejectionReason, onReject]);

  const handleRejectCancel = useCallback(() => {
    setShowRejectDialog(false);
    setRejectionReason('');
  }, []);

  if (!canApprove || !isPending) {
    return (
      <div className="invoice-proposal-actions" data-testid="invoice-proposal-actions">
        <span data-testid="no-actions-message">
          {!canApprove ? 'Insufficient permissions' : `Status: ${status}`}
        </span>
      </div>
    );
  }

  return (
    <div className="invoice-proposal-actions" data-testid="invoice-proposal-actions">
      <button data-testid="approve-button" onClick={handleApprove}>
        Approve Invoice
      </button>
      <button data-testid="reject-button" onClick={handleRejectClick}>
        Reject Invoice
      </button>

      {showRejectDialog && (
        <div className="rejection-dialog" data-testid="rejection-dialog">
          <label htmlFor="rejection-reason">Rejection Reason:</label>
          <textarea
            id="rejection-reason"
            data-testid="rejection-reason-input"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            placeholder="Please provide a reason for rejection"
          />
          <div className="dialog-actions">
            <button
              data-testid="confirm-reject-button"
              onClick={handleRejectConfirm}
              disabled={!rejectionReason.trim()}
            >
              Confirm Rejection
            </button>
            <button data-testid="cancel-reject-button" onClick={handleRejectCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
