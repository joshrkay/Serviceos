import React from 'react';

/**
 * P6-025 — Confirmation dialog shown before a drag-drop schedule change is
 * converted into a proposal POST. This is the safety gate that makes drag the
 * *intent* and not the *execution* — the appointment stays in place until the
 * proposal is approved.
 *
 * Implementation note: kept as a self-contained Tailwind overlay rather than
 * pulling in Radix Dialog. The dispatch flow needs synchronous focus + simple
 * confirm/cancel semantics; portaling and animation aren't required and a
 * lighter component keeps the test surface small.
 */

export type ProposedProposalType =
  | 'reassign_appointment'
  | 'reschedule_appointment'
  | 'cancel_assignment';

export interface ConfirmProposalDialogProps {
  open: boolean;
  proposalType: ProposedProposalType | null;
  appointmentSummary?: string;
  targetDescription?: string;
  isSubmitting?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const PROPOSAL_TITLE: Record<ProposedProposalType, string> = {
  reassign_appointment: 'Reassign appointment?',
  reschedule_appointment: 'Reschedule appointment?',
  cancel_assignment: 'Cancel this assignment?',
};

const PROPOSAL_DESCRIPTION: Record<ProposedProposalType, string> = {
  reassign_appointment:
    'A reassign proposal will be created. The appointment stays in its current lane until a teammate approves the proposal.',
  reschedule_appointment:
    'A reschedule proposal will be created. The appointment time will not change until a teammate approves the proposal.',
  cancel_assignment:
    'A cancel-assignment proposal will be created. The appointment stays assigned until a teammate approves the proposal.',
};

export function ConfirmProposalDialog({
  open,
  proposalType,
  appointmentSummary,
  targetDescription,
  isSubmitting = false,
  onConfirm,
  onCancel,
}: ConfirmProposalDialogProps) {
  if (!open || !proposalType) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      data-testid="confirm-proposal-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-proposal-title"
    >
      <div
        className="absolute inset-0 bg-black/50"
        data-testid="confirm-proposal-overlay"
        onClick={isSubmitting ? undefined : onCancel}
      />
      <div className="relative z-10 w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-900">
        <h2
          id="confirm-proposal-title"
          className="text-lg font-semibold"
          data-testid="confirm-proposal-title"
        >
          {PROPOSAL_TITLE[proposalType]}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {PROPOSAL_DESCRIPTION[proposalType]}
        </p>
        {(appointmentSummary || targetDescription) && (
          <div
            className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-800"
            data-testid="confirm-proposal-summary"
          >
            {appointmentSummary && (
              <div>
                <span className="font-medium">Appointment:</span> {appointmentSummary}
              </div>
            )}
            {targetDescription && (
              <div>
                <span className="font-medium">Change:</span> {targetDescription}
              </div>
            )}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded border border-gray-300 px-4 py-2 text-sm hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
            data-testid="confirm-proposal-cancel"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="confirm-proposal-confirm"
            onClick={onConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating proposal...' : 'Create proposal'}
          </button>
        </div>
      </div>
    </div>
  );
}
