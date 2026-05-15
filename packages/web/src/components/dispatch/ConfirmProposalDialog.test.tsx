import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmProposalDialog } from './ConfirmProposalDialog';

/**
 * Backfill tests for ConfirmProposalDialog (P6-025).
 *
 * Adapter notes (actual component vs. plan template):
 * - proposalType is `ProposedProposalType | null`, not just `ProposedProposalType`
 * - appointmentSummary and targetDescription are optional
 * - Primary button always reads "Create proposal" / "Creating proposal..." regardless of
 *   proposalType — there are no type-specific confirm labels.
 * - Secondary button always reads "Cancel".
 * - appointmentSummary is rendered inside a div as:
 *     <span>Appointment:</span> HVAC tune-up @ 123 Main St
 *   so getByText on the bare string fails. We assert via the summary container's
 *   textContent or a regex instead.
 * - Both buttons are disabled when isSubmitting=true; we target the primary button by
 *   data-testid to avoid ambiguity.
 * - Closed state: component returns null when !open || !proposalType, so the container
 *   is empty.
 */

describe('ConfirmProposalDialog', () => {
  const baseProps = {
    open: true,
    proposalType: 'reschedule_appointment' as const,
    appointmentSummary: 'HVAC tune-up @ 123 Main St',
    targetDescription: 'Tomorrow 9:00 AM',
    isSubmitting: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders the summary and target when open', () => {
    render(<ConfirmProposalDialog {...baseProps} />);
    // Summary box contains both values (rendered with prefix spans, so we check
    // the container's textContent rather than exact string matching).
    const summaryBox = screen.getByTestId('confirm-proposal-summary');
    expect(summaryBox).toHaveTextContent('HVAC tune-up @ 123 Main St');
    expect(summaryBox).toHaveTextContent('Tomorrow 9:00 AM');
  });

  it('renders nothing when closed', () => {
    const { container } = render(<ConfirmProposalDialog {...baseProps} open={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when proposalType is null', () => {
    const { container } = render(
      <ConfirmProposalDialog {...baseProps} proposalType={null} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onConfirm when the primary action is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmProposalDialog {...baseProps} onConfirm={onConfirm} />);
    // Primary button always reads "Create proposal" regardless of proposalType.
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('calls onCancel when the secondary action is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmProposalDialog {...baseProps} onCancel={onCancel} />);
    // Secondary button always reads "Cancel".
    fireEvent.click(screen.getByTestId('confirm-proposal-cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables the primary action while submitting', () => {
    render(<ConfirmProposalDialog {...baseProps} isSubmitting={true} />);
    // Label changes to "Creating proposal..." and button is disabled.
    const confirmButton = screen.getByTestId('confirm-proposal-confirm');
    expect(confirmButton).toBeDisabled();
    expect(confirmButton).toHaveTextContent(/creating proposal/i);
  });

  it('shows the correct title for each proposalType', () => {
    const cases: Array<[string, string]> = [
      ['reassign_appointment', 'Reassign appointment?'],
      ['reschedule_appointment', 'Reschedule appointment?'],
      ['cancel_appointment', 'Cancel this assignment?'],
    ];

    for (const [type, expectedTitle] of cases) {
      const { unmount } = render(
        <ConfirmProposalDialog
          {...baseProps}
          proposalType={type as 'reassign_appointment' | 'reschedule_appointment' | 'cancel_appointment'}
        />
      );
      expect(screen.getByTestId('confirm-proposal-title')).toHaveTextContent(expectedTitle);
      unmount();
    }
  });
});
