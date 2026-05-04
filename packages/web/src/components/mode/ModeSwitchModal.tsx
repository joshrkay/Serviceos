/**
 * P12-003 — ModeSwitchModal.
 *
 * Confirmation surface that interrupts a mode switch when the
 * destination *crosses out of supervisor coverage* — i.e. the user is
 * leaving 'supervisor' or 'both' and entering 'tech'. We do NOT show
 * the modal for gentler transitions (tech→both, both→supervisor); per
 * the plan those expand the surface and add coverage rather than
 * removing it, so a confirm is friction without value.
 *
 * Suppression rules (matches Appendix C of the ship-this-week plan):
 *   - supervisor → tech : SHOW
 *   - both       → tech : SHOW
 *   - everything else   : SUPPRESS (caller invokes onConfirm directly)
 *
 * The modal is presentation only — the parent owns the actual
 * `switchMode` call. We never invoke it from inside the modal so a
 * caller can wrap the confirm flow with audit / analytics / GPS state
 * before performing the switch.
 */
import type { Mode } from '../../hooks/useMe';

export interface ModeSwitchModalProps {
  from: Mode;
  to: Mode;
  activeSessionCount: number;
  pendingProposalCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

const MODE_LABEL: Record<Mode, string> = {
  supervisor: 'Supervisor',
  tech: 'Tech',
  both: 'Both',
};

export function shouldShowModeSwitchModal(from: Mode, to: Mode): boolean {
  if (from === to) return false;
  // Only the "leaving supervisor coverage" transitions warrant friction.
  return (from === 'supervisor' || from === 'both') && to === 'tech';
}

const TECH_DESTINATION_NOTES: ReadonlyArray<string> = [
  'Auto-approve threshold rises to 0.95 — most proposals queue for human review.',
  'Low-confidence proposals route per Settings → Unsupervised routing (default: queue + SMS to owner).',
  'Voice approval becomes read-only — writes require a button tap on the phone screen.',
  'Emergency intents on inbound calls Dial the on-call rotation immediately.',
  'The session wall collapses to a mini-strip; full panels return when you switch back.',
];

export function ModeSwitchModal({
  from,
  to,
  activeSessionCount,
  pendingProposalCount,
  onConfirm,
  onCancel,
}: ModeSwitchModalProps): JSX.Element | null {
  if (!shouldShowModeSwitchModal(from, to)) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-switch-modal-title"
      data-testid="mode-switch-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div className="w-full max-w-md rounded-lg bg-white shadow-lg">
        <div className="px-6 pt-5 pb-2">
          <h2
            id="mode-switch-modal-title"
            className="text-base text-slate-900"
          >
            Switch to {MODE_LABEL[to]} mode?
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            You're leaving {MODE_LABEL[from]} mode. The AI behavior changes
            below take effect immediately for new proposals.
          </p>
        </div>

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50">
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-slate-500">Active sessions</dt>
              <dd className="text-slate-900" data-testid="active-session-count">
                {activeSessionCount}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Pending review</dt>
              <dd className="text-slate-900" data-testid="pending-proposal-count">
                {pendingProposalCount}
              </dd>
            </div>
          </dl>
        </div>

        <div className="px-6 py-3 border-t border-slate-100">
          <p className="text-xs text-slate-700 mb-2">In Tech mode:</p>
          <ul className="space-y-1.5 text-xs text-slate-600">
            {TECH_DESTINATION_NOTES.map((note) => (
              <li key={note} className="flex gap-2">
                <span className="text-slate-400">•</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            data-testid="mode-switch-confirm"
            className="text-xs px-3 py-1.5 rounded-md bg-slate-900 text-white hover:bg-slate-800"
          >
            Switch to {MODE_LABEL[to]}
          </button>
        </div>
      </div>
    </div>
  );
}
