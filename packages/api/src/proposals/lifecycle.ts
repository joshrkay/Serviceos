import type { Proposal, ProposalStatus } from './proposal';
import { ConflictError, ForbiddenError } from '../shared/errors';

/**
 * QUALITY-2026-07-12 WS2 — human-authority invariant. A `system:` actor
 * (e.g. the on-call close drafter) may CREATE and stage proposals but may
 * NEVER approve one: approval is the point at which canonical writes, customer
 * communication, booking confirmation, and money movement become authorized,
 * and that gate belongs to a human (owner). This is the structural seam every
 * approval transition flows through (approveProposal → transitionProposal), so
 * the invariant cannot be bypassed by a future caller.
 */
export function isSystemActor(actorId: string): boolean {
  return actorId.startsWith('system:');
}

const VALID_TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  // A draft can be promoted to ready_for_review, or acted on directly:
  // the operator inbox surfaces drafts (voice proposals are created in
  // 'draft') and approves/rejects them in place. approveProposal still
  // refuses a draft with unfilled missingFields, so a half-extracted
  // payload can't be approved straight from 'draft'.
  draft: ['ready_for_review', 'approved', 'rejected', 'expired'],
  // → draft: a supervisor hold pulls a queued card back out of review
  // (ai/supervisor/reviewer.ts) so no one-tap link or approval text goes out.
  ready_for_review: ['approved', 'rejected', 'expired', 'draft'],
  // Decision 9 undo window: approved proposals can transition to
  // 'undone' within UNDO_WINDOW_MS. After the window passes, the
  // only valid next states are 'executed' / 'execution_failed'.
  // → executing: the execution sweep's claim. → rejected: a caller revoking
  // their own still-unexecuted booking mid-call (E1, voice-turn processor).
  approved: ['executing', 'executed', 'execution_failed', 'undone', 'rejected'],
  // → approved: the executor releases a claimed chain dependent whose parent
  // has not executed yet, so the next sweep tick retries it.
  executing: ['executed', 'execution_failed', 'approved'],
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
  // Only `status` and `approvedAt` are read. Structural (not `Proposal`) so the
  // onboarding status read's fact rows, which carry pg's `null` for an unset
  // `approved_at`, are judged by this ONE predicate rather than a copy of it
  // (onboarding/derive-status.ts). A full Proposal still satisfies it.
  proposal: { readonly status: string; readonly approvedAt?: Date | null },
  nowMs: number = Date.now(),
  windowMs: number = UNDO_WINDOW_MS
): boolean {
  if (proposal.status !== 'approved') return false;
  if (!proposal.approvedAt) return false;
  const elapsed = nowMs - proposal.approvedAt.getTime();
  return elapsed < windowMs;
}

/**
 * Finding 2 — the instant the 5-second undo window closes for an approved
 * proposal: `approvedAt + windowMs`. Returns undefined when the proposal has
 * no `approvedAt` (historical rows, or a non-approved proposal) so the
 * response layer can OMIT the field rather than emit a bogus expiry.
 *
 * The client drives its undo countdown from this instant (not a fresh 5s at
 * round-trip-return time), so the tail of the window the approve round-trip
 * already consumed is never offered as undoable.
 */
export function undoExpiresAt(
  // Only `approvedAt` is read. Narrowed from `Proposal` so callers holding
  // just the stamp (routes/assistant.ts's card mapper, which takes a
  // structural literal rather than a persisted row) can derive the window
  // from the ONE helper that owns the derivation instead of re-adding
  // UNDO_WINDOW_MS themselves. A full Proposal still satisfies it.
  proposal: Pick<Proposal, 'approvedAt'>,
  windowMs: number = UNDO_WINDOW_MS
): Date | undefined {
  if (!proposal.approvedAt) return undefined;
  return new Date(proposal.approvedAt.getTime() + windowMs);
}

/**
 * Milliseconds of undo window LEFT as of `now` (default: this instant).
 * Returns undefined when there is no window, and 0 when it has closed.
 *
 * Follow-up review N11 — `undoExpiresAt` alone is a SERVER instant that the
 * client compares against its own `Date.now()`. Any clock skew is subtracted
 * straight out of a 5-second budget the chat round trip (an LLM call) has
 * already eaten most of: skew one way hides a valid undo, the other way
 * offers one the server then 409s. A DURATION carries no clock, so the client
 * can anchor it to its own clock at the moment it receives the response and
 * be wrong only by the response's transit time — which is strictly less than
 * the error a skewed absolute comparison can produce.
 */
export function undoRemainingMs(
  proposal: Pick<Proposal, 'approvedAt'>,
  windowMs: number = UNDO_WINDOW_MS,
  now: Date = new Date(),
): number | undefined {
  const closesAt = undoExpiresAt(proposal, windowMs);
  if (!closesAt) return undefined;
  return Math.max(0, closesAt.getTime() - now.getTime());
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * The status-write gate. Every repository status write runs it, so a caller
 * cannot move a proposal along an edge the table above does not list. A write
 * to the status the row already has is a re-stamp, not a move, and passes.
 */
export function assertStatusWrite(from: ProposalStatus, to: ProposalStatus): void {
  if (from === to || canTransition(from, to)) return;
  throw new ConflictError(`Cannot transition proposal from '${from}' to '${to}'`);
}

export function isTerminalStatus(status: ProposalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function transitionProposal(
  proposal: Proposal,
  targetStatus: ProposalStatus,
  actorId: string
): Proposal {
  // WS2 human-authority invariant: a system actor can never approve. This is
  // deliberately structural (not scattered across call sites) — every approval
  // path stamps `approvedAt` here.
  if (targetStatus === 'approved' && isSystemActor(actorId)) {
    throw new ForbiddenError(
      `Proposal approval requires a human actor — '${actorId}' may not approve a proposal`,
    );
  }
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
