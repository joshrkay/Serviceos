import React, { useMemo, useState } from 'react';
import { ConflictDisplay, ConflictInfo } from './ConflictDisplay';
import type { FeasibilityResult } from './feasibility-types';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { formatTimeInTenantTz } from '../../utils/formatInTenantTz';

/**
 * P6-025 — Confirmation dialog shown before a drag-drop schedule change is
 * converted into a proposal POST.
 */

export type ProposedProposalType =
  | 'reassign_appointment'
  | 'reschedule_appointment'
  | 'cancel_appointment';

export interface TimeRangeDisplay {
  fromStart: string;
  fromEnd: string;
  toStart: string;
  toEnd: string;
}

export interface ConfirmProposalDialogProps {
  open: boolean;
  proposalType: ProposedProposalType | null;
  appointmentSummary?: string;
  targetDescription?: string;
  timeRange?: TimeRangeDisplay;
  feasibility?: FeasibilityResult | null;
  presenceWarning?: string;
  allowTimeEdit?: boolean;
  editedStart?: string;
  editedEnd?: string;
  onEditedTimesChange?: (start: string, end: string) => void;
  isSubmitting?: boolean;
  /**
   * `acceptOverlap` is true only when the dispatcher ticked "Book anyway" on
   * a reassign whose sole blockers are visits already on the tech's calendar.
   */
  onConfirm: (options: { acceptOverlap: boolean }) => void;
  onCancel: () => void;
}

const PROPOSAL_TITLE: Record<ProposedProposalType, string> = {
  reassign_appointment: 'Reassign appointment?',
  reschedule_appointment: 'Reschedule appointment?',
  cancel_appointment: 'Cancel this assignment?',
};

const PROPOSAL_DESCRIPTION: Record<ProposedProposalType, string> = {
  reassign_appointment:
    'A reassign proposal will be created. The appointment stays in its current lane until a teammate approves the proposal.',
  reschedule_appointment:
    'A reschedule proposal will be created. The appointment time will not change until a teammate approves the proposal.',
  cancel_appointment:
    'A cancel-assignment proposal will be created. The appointment stays assigned until a teammate approves the proposal.',
};

// Journey QA 2026-07-02 (bug 4) — render in the TENANT tz (core pattern:
// stored UTC, rendered in tenant timezone), matching the schedule page.
function formatTime(iso: string, tz: string): string {
  if (!iso) return '—';
  return formatTimeInTenantTz(iso, tz);
}

function feasibilityToConflicts(result: FeasibilityResult): ConflictInfo[] {
  return [
    ...result.blocking.map((i) => ({
      type: i.check,
      severity: 'blocking' as const,
      message: i.message,
      conflictingEntityId: i.conflictingEntityId,
    })),
    ...result.warnings.map((i) => ({
      type: i.check,
      severity: 'warning' as const,
      message: i.message,
      conflictingEntityId: i.conflictingEntityId,
    })),
  ];
}

/** Blocked, and every blocker is a clash with a visit already booked. */
export function overlapOnlyBlocking(result: FeasibilityResult | null | undefined): boolean {
  if (!result || result.blocking.length === 0) return false;
  return result.blocking.every((i) => i.check === 'overlap');
}

export function ConfirmProposalDialog({
  open,
  proposalType,
  appointmentSummary,
  targetDescription,
  timeRange,
  feasibility,
  presenceWarning,
  allowTimeEdit = false,
  editedStart = '',
  editedEnd = '',
  onEditedTimesChange,
  isSubmitting = false,
  onConfirm,
  onCancel,
}: ConfirmProposalDialogProps) {
  const tz = useTenantTimezone();
  const [warningsAcknowledged, setWarningsAcknowledged] = useState(false);
  const [overlapAccepted, setOverlapAccepted] = useState(false);

  React.useEffect(() => {
    if (!open) {
      setWarningsAcknowledged(false);
      setOverlapAccepted(false);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onCancel();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [open, isSubmitting, onCancel]);

  const conflicts = useMemo(
    () => (feasibility ? feasibilityToConflicts(feasibility) : []),
    [feasibility],
  );

  const hasBlocking = (feasibility?.blocking.length ?? 0) > 0;
  const hasWarnings = (feasibility?.warnings.length ?? 0) > 0;
  const hasWarningsOnly = hasWarnings && !hasBlocking;
  // FR-2 phase 3c (Josh, 2026-10-22: "Allow overlap if select by user") — a
  // reassign blocked ONLY by clashing visits can be booked anyway, but only
  // through this explicit tick. Skills, hours and time off still block.
  const canAcceptOverlap = proposalType === 'reassign_appointment' && overlapOnlyBlocking(feasibility);
  const acceptOverlap = canAcceptOverlap && overlapAccepted;

  const confirmDisabled =
    isSubmitting ||
    (hasBlocking && !acceptOverlap) ||
    (hasWarnings && !warningsAcknowledged) ||
    (allowTimeEdit && (!editedStart || !editedEnd));

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
        {presenceWarning && (
          <p className="mt-2 text-sm text-amber-700" data-testid="confirm-presence-warning">
            {presenceWarning}
          </p>
        )}
        {(appointmentSummary || targetDescription || timeRange) && (
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
            {timeRange && (
              <div data-testid="confirm-time-range">
                <span className="font-medium">Time:</span>{' '}
                {formatTime(timeRange.fromStart, tz)}–{formatTime(timeRange.fromEnd, tz)}
                {' → '}
                {formatTime(timeRange.toStart, tz)}–{formatTime(timeRange.toEnd, tz)}
              </div>
            )}
          </div>
        )}
        {allowTimeEdit && onEditedTimesChange && (
          <div className="mt-4 space-y-2" data-testid="confirm-time-edit">
            <label className="block text-xs font-medium text-gray-600">
              New start
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border px-2 py-1 text-sm"
                value={editedStart}
                onChange={(e) => onEditedTimesChange(e.target.value, editedEnd)}
              />
            </label>
            <label className="block text-xs font-medium text-gray-600">
              New end
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border px-2 py-1 text-sm"
                value={editedEnd}
                onChange={(e) => onEditedTimesChange(editedStart, e.target.value)}
              />
            </label>
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="mt-4">
            <ConflictDisplay
              conflicts={conflicts}
              onAcknowledgeWarnings={
                hasWarningsOnly ? () => setWarningsAcknowledged(true) : undefined
              }
            />
          </div>
        )}
        {canAcceptOverlap && (
          <label
            className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            data-testid="confirm-accept-overlap"
          >
            <input
              type="checkbox"
              className="h-5 w-5 shrink-0"
              checked={overlapAccepted}
              onChange={(e) => setOverlapAccepted(e.target.checked)}
              data-testid="confirm-accept-overlap-checkbox"
            />
            <span className="break-words">
              Book anyway: I accept this overlap. The approver will see that you chose it.
            </span>
          </label>
        )}
        {canAcceptOverlap && overlapAccepted && hasWarnings && !warningsAcknowledged && (
          <button
            type="button"
            className="mt-2 min-h-11 w-full rounded border border-gray-300 px-3 text-sm hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800"
            onClick={() => setWarningsAcknowledged(true)}
            data-testid="confirm-acknowledge-warnings"
          >
            Acknowledge the warnings too
          </button>
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
            onClick={() => onConfirm({ acceptOverlap })}
            disabled={confirmDisabled}
          >
            {isSubmitting ? 'Creating proposal...' : 'Create proposal'}
          </button>
        </div>
      </div>
    </div>
  );
}
