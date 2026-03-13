import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InvoiceProposalActions, canApproveProposal } from './InvoiceProposalActions';

describe('P5-004C InvoiceProposalActions', () => {
  it('shows approve/reject buttons for owner role with pending status', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId('approve-button')).toBeDefined();
    expect(screen.getByTestId('reject-button')).toBeDefined();
  });

  it('shows approve/reject buttons for dispatcher role', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="dispatcher"
        status="draft"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId('approve-button')).toBeDefined();
    expect(screen.getByTestId('reject-button')).toBeDefined();
  });

  it('hides buttons for technician role (no proposals:approve permission)', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="technician"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.queryByTestId('approve-button')).toBeNull();
    expect(screen.queryByTestId('reject-button')).toBeNull();
    expect(screen.getByTestId('no-actions-message').textContent).toContain(
      'Insufficient permissions'
    );
  });

  it('hides buttons when status is not pending/draft/ready_for_review', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="approved"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.queryByTestId('approve-button')).toBeNull();
    expect(screen.queryByTestId('reject-button')).toBeNull();
    expect(screen.getByTestId('no-actions-message').textContent).toContain('Status: approved');
  });

  it('shows buttons for ready_for_review status', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="ready_for_review"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId('approve-button')).toBeDefined();
    expect(screen.getByTestId('reject-button')).toBeDefined();
  });

  it('clicking approve calls onApprove', () => {
    const onApprove = vi.fn();
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={onApprove}
        onReject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('approve-button'));
    expect(onApprove).toHaveBeenCalledWith('prop-1');
  });

  it('clicking reject shows rejection dialog', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.queryByTestId('rejection-dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('reject-button'));
    expect(screen.getByTestId('rejection-dialog')).toBeDefined();
  });

  it('rejection dialog requires reason text (confirm button disabled when empty)', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('reject-button'));
    const confirmBtn = screen.getByTestId('confirm-reject-button') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('confirm reject calls onReject with reason', () => {
    const onReject = vi.fn();
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={vi.fn()}
        onReject={onReject}
      />
    );
    fireEvent.click(screen.getByTestId('reject-button'));
    fireEvent.change(screen.getByTestId('rejection-reason-input'), {
      target: { value: 'Incorrect amount' },
    });
    fireEvent.click(screen.getByTestId('confirm-reject-button'));
    expect(onReject).toHaveBeenCalledWith('prop-1', 'Incorrect amount');
  });

  it('cancel reject hides dialog', () => {
    render(
      <InvoiceProposalActions
        proposalId="prop-1"
        userRole="owner"
        status="pending"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('reject-button'));
    expect(screen.getByTestId('rejection-dialog')).toBeDefined();
    fireEvent.click(screen.getByTestId('cancel-reject-button'));
    expect(screen.queryByTestId('rejection-dialog')).toBeNull();
  });

  it('canApproveProposal returns correct results per role', () => {
    expect(canApproveProposal('owner')).toBe(true);
    expect(canApproveProposal('dispatcher')).toBe(true);
    expect(canApproveProposal('technician')).toBe(false);
  });
});
