import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ProposalCard, canApproveProposal } from './ProposalCard';
import { Proposal } from '../../types/conversation';

describe('P3-006 — Inline proposal rendering with quick actions', () => {
  const pendingProposal: Proposal = {
    id: 'prop-1',
    type: 'create_job',
    summary: 'Create new HVAC installation job for 123 Main St',
    status: 'pending',
    details: { address: '123 Main St', serviceType: 'HVAC installation' },
    createdAt: '2024-01-01T10:00:00Z',
  };

  const approvedProposal: Proposal = {
    ...pendingProposal,
    id: 'prop-2',
    status: 'approved',
  };

  it('happy path — renders proposal with correct status and actions', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onOpenDetail = vi.fn();
    render(
      <ProposalCard
        proposal={pendingProposal}
        userRole="owner"
        onApprove={onApprove}
        onReject={onReject}
        onOpenDetail={onOpenDetail}
      />
    );

    expect(screen.getByTestId('proposal-type')).toHaveTextContent('create_job');
    expect(screen.getByTestId('proposal-status')).toHaveTextContent('Pending');
    expect(screen.getByTestId('proposal-summary')).toHaveTextContent(
      'Create new HVAC installation job for 123 Main St'
    );
    expect(screen.getByTestId('proposal-approve-button')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-reject-button')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-detail-button')).toBeInTheDocument();
  });

  it('happy path — approve action calls onApprove', () => {
    const onApprove = vi.fn();
    render(
      <ProposalCard proposal={pendingProposal} userRole="owner" onApprove={onApprove} />
    );
    fireEvent.click(screen.getByTestId('proposal-approve-button'));
    expect(onApprove).toHaveBeenCalledWith('prop-1');
  });

  it('happy path — reject action calls onReject', () => {
    const onReject = vi.fn();
    render(
      <ProposalCard proposal={pendingProposal} userRole="dispatcher" onReject={onReject} />
    );
    fireEvent.click(screen.getByTestId('proposal-reject-button'));
    expect(onReject).toHaveBeenCalledWith('prop-1');
  });

  it('happy path — approved proposal shows no approve/reject buttons', () => {
    render(
      <ProposalCard
        proposal={approvedProposal}
        userRole="owner"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId('proposal-status')).toHaveTextContent('Approved');
    expect(screen.queryByTestId('proposal-approve-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposal-reject-button')).not.toBeInTheDocument();
  });

  it('validation — approve action disabled for technician role', () => {
    render(
      <ProposalCard
        proposal={pendingProposal}
        userRole="technician"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onOpenDetail={vi.fn()}
      />
    );
    expect(screen.queryByTestId('proposal-approve-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposal-reject-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('proposal-detail-button')).toBeInTheDocument();
  });

  it('happy path — canApproveProposal returns correct values', () => {
    expect(canApproveProposal('owner')).toBe(true);
    expect(canApproveProposal('dispatcher')).toBe(true);
    expect(canApproveProposal('technician')).toBe(false);
  });
});
