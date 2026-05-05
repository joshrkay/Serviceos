import { Proposal, ProposalStatus } from './proposal';
import { ConflictError } from '../shared/errors';

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  draft: ['ready_for_review'],
  ready_for_review: ['approved', 'rejected', 'expired'],
  // Decision 9 undo window: approved proposals can transition to
  // 'undone' within UNDO_WINDOW_MS. After the window passes, the
  // only valid next states are 'executed' / 'execution_failed'.
  approved: ['executed', 'execution_failed', 'undone'],
  executing: ['executed', 'execution_failed'],
  rejected: ['draft'],
  expired: [],
  executed: [],
  execution_failed: ['draft'],
  // Terminal: an undone proposal cannot be resurrected. If the
  // operator changes their mind again, they draft a new proposal.
  undone: [],
};

const TERMINAL_STATUSES: ProposalStatus[] = ['expired', 'executed', 'undone'];

/**
 * Decision 9 — 5-second undo window.
 *
 * The time an auto-approved proposal sits in 'approved' status before
 * the executor is allowed to run it. During this window the operator
 * can call `undoProposal` to reverse the approval. After the window
 * passes, execution proceeds normally.
 *
 * Exported so tests can reference the same constant rather than
 * hard-coding 5000. Not operator-configurable for now — that's a
 * follow-up once the per-tenant settings surface supports it.
 */
export const UNDO_WINDOW_MS = 5000;

/**
 * True if the proposal is currently inside the 5-second undo window.
 *
 * The check is deliberately conservative:
 *  - missing `approvedAt` → false (treat as "window closed"). This
 *    preserves backward compatibility for historical proposals that
 *    were approved before this slice landed; the executor still runs
 *    them immediately.
 *  - wrong status (not 'approved') → false. Only approved proposals
 *    have an undo window.
 *  - now - approvedAt >= windowMs → false. Window has closed.
 */
export function isInUndoWindow(
  proposal: Proposal,
  nowMs: number = Date.now(),
  windowMs: number = UNDO_WINDOW_MS
): boolean {
  if (proposal.status !== 'approved') return false;
  if (!proposal.approvedAt) return false;
  const elapsed = nowMs - proposal.approvedAt.getTime();
  return elapsed < windowMs;
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function isTerminalStatus(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function transitionProposal(
  proposal: Proposal,
  targetStatus: ProposalStatus,
  actorId: string
): Proposal {
  if (!canTransition(proposal.status, targetStatus)) {
    throw new ConflictError(
      `Cannot transition proposal from '${proposal.status}' to '${targetStatus}'`
    );
  }

  const now = new Date();
  const next: Proposal = {
    ...proposal,
    status: targetStatus,
    updatedAt: now,
  };

  // Stamp the transition-specific timestamp. Idempotent: if the
  // caller already set one via another update path, we don't
  // overwrite it — only stamp when the field is currently unset.
  if (targetStatus === 'approved' && !next.approvedAt) {
    next.approvedAt = now;
  }
  if (targetStatus === 'undone' && !next.undoneAt) {
    next.undoneAt = now;
    next.undoneBy = actorId;
  }

  return next;
}
