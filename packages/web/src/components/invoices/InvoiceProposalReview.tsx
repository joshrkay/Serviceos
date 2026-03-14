import React from 'react';

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  category?: string;
}

export interface InvoiceProposalData {
  id: string;
  customerId: string;
  jobId: string;
  estimateId?: string;
  lineItems: InvoiceLineItem[];
  discountCents: number;
  taxRateBps: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  customerMessage?: string;
  explanation?: string;
  confidenceScore?: number;
  status: string;
}

export interface InvoiceProposalReviewProps {
  proposal: InvoiceProposalData;
  onEdit?: (proposalId: string) => void;
  onApprove?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function InvoiceProposalReview({
  proposal,
  onEdit,
  onApprove,
  onReject,
}: InvoiceProposalReviewProps) {
  return (
    <div className="invoice-proposal-review" data-testid="invoice-proposal-review">
      <div className="proposal-header" data-testid="proposal-header">
        <h3>Invoice Proposal</h3>
        <span className="proposal-status" data-testid="proposal-status">
          {proposal.status}
        </span>
        {proposal.confidenceScore !== undefined && (
          <span className="confidence-score" data-testid="confidence-score">
            {Math.round(proposal.confidenceScore * 100)}% confidence
          </span>
        )}
      </div>

      {proposal.explanation && (
        <div className="proposal-explanation" data-testid="proposal-explanation">
          {proposal.explanation}
        </div>
      )}

      <table className="line-items-table" data-testid="line-items-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Unit Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {proposal.lineItems.map((item, index) => (
            <tr key={index} data-testid={`line-item-${index}`}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatCents(item.unitPrice)}</td>
              <td>{formatCents(Math.round(item.quantity * item.unitPrice))}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="totals-section" data-testid="totals-section">
        <div className="total-row" data-testid="subtotal">
          <span>Subtotal:</span>
          <span>{formatCents(proposal.subtotalCents)}</span>
        </div>
        {proposal.discountCents > 0 && (
          <div className="total-row" data-testid="discount">
            <span>Discount:</span>
            <span>-{formatCents(proposal.discountCents)}</span>
          </div>
        )}
        {proposal.taxRateBps > 0 && (
          <div className="total-row" data-testid="tax">
            <span>Tax ({formatBps(proposal.taxRateBps)}):</span>
            <span>{formatCents(proposal.taxCents)}</span>
          </div>
        )}
        <div className="total-row total-final" data-testid="total">
          <span>Total:</span>
          <span>{formatCents(proposal.totalCents)}</span>
        </div>
      </div>

      {proposal.customerMessage && (
        <div className="customer-message" data-testid="customer-message">
          <strong>Customer Message:</strong> {proposal.customerMessage}
        </div>
      )}

      {proposal.estimateId && (
        <div className="estimate-reference" data-testid="estimate-reference">
          Based on estimate: {proposal.estimateId}
        </div>
      )}
    </div>
  );
}
