import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmProposalDialog } from './ConfirmProposalDialog';
import type { FeasibilityResult } from './feasibility-types';

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

  it('calls onConfirm (with no accepted overlap) when the primary action is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmProposalDialog {...baseProps} onConfirm={onConfirm} />);
    // Primary button always reads "Create proposal" regardless of proposalType.
    fireEvent.click(screen.getByTestId('confirm-proposal-confirm'));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith({ acceptOverlap: false });
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

// Dispatch FR-2 phase 3c — "Allow overlap if select by user": a reassign
// blocked ONLY by clashing visits can be booked anyway, through an explicit
// tick. Anything else blocking (skill, hours) keeps Confirm disabled.
describe('ConfirmProposalDialog — dispatcher-accepted overlap', () => {
  type Issue = FeasibilityResult['blocking'][number];
  const overlapIssue: Issue = { check: 'overlap', severity: 'blocking', message: 'Overlaps with appointment a-2', conflictingEntityId: 'a-2' };
  const skillIssue: Issue = { check: 'skill_match', severity: 'blocking', message: 'Technician is missing required skill(s): hvac' };
  const travelWarning: Issue = { check: 'travel_time', severity: 'warning', message: 'Tight drive' };
  const feasibility = (blocking: Issue[], warnings: Issue[] = []): FeasibilityResult => ({
    feasible: false, blocking, warnings, info: [],
    travelTime: { fromPrevSeconds: null, toNextSeconds: null, estimateSource: 'unknown', degraded: false },
    skillConstraints: 'none_configured',
  });
  const props = {
    open: true, proposalType: 'reassign_appointment' as const, isSubmitting: false, onCancel: vi.fn(),
  };

  it('offers a ≥44px "Book anyway" tick for an overlap-only block, enabling Confirm which passes acceptOverlap', () => {
    const onConfirm = vi.fn();
    render(<ConfirmProposalDialog {...props} feasibility={feasibility([overlapIssue])} onConfirm={onConfirm} />);
    const confirm = screen.getByTestId('confirm-proposal-confirm');
    expect(confirm).toBeDisabled();
    const tick = screen.getByTestId('confirm-accept-overlap');
    expect(tick.className).toMatch(/\bmin-h-11\b/);
    expect(tick).toHaveTextContent('Book anyway');
    fireEvent.click(screen.getByTestId('confirm-accept-overlap-checkbox'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ acceptOverlap: true });
  });

  it('does not offer the tick when something other than an overlap blocks', () => {
    render(<ConfirmProposalDialog {...props} feasibility={feasibility([overlapIssue, skillIssue])} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId('confirm-accept-overlap')).toBeNull();
    expect(screen.getByTestId('confirm-proposal-confirm')).toBeDisabled();
  });

  it('does not offer the tick on a reschedule (reassign only)', () => {
    render(<ConfirmProposalDialog {...props} proposalType="reschedule_appointment" feasibility={feasibility([overlapIssue])} onConfirm={vi.fn()} />);
    expect(screen.queryByTestId('confirm-accept-overlap')).toBeNull();
  });

  it('still requires the warnings to be acknowledged after the overlap is accepted', () => {
    const onConfirm = vi.fn();
    render(<ConfirmProposalDialog {...props} feasibility={feasibility([overlapIssue], [travelWarning])} onConfirm={onConfirm} />);
    const confirm = screen.getByTestId('confirm-proposal-confirm');
    fireEvent.click(screen.getByTestId('confirm-accept-overlap-checkbox'));
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('confirm-acknowledge-warnings'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ acceptOverlap: true });
  });

  it('forgets the tick when the dialog closes', () => {
    const { rerender } = render(<ConfirmProposalDialog {...props} feasibility={feasibility([overlapIssue])} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByTestId('confirm-accept-overlap-checkbox'));
    rerender(<ConfirmProposalDialog {...props} open={false} feasibility={feasibility([overlapIssue])} onConfirm={vi.fn()} />);
    rerender(<ConfirmProposalDialog {...props} feasibility={feasibility([overlapIssue])} onConfirm={vi.fn()} />);
    expect(screen.getByTestId('confirm-accept-overlap-checkbox')).not.toBeChecked();
    expect(screen.getByTestId('confirm-proposal-confirm')).toBeDisabled();
  });
});
