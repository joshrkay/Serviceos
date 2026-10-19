/**
 * Whole-draft undo — "Saving your choices. Tap Undo if that's not right."
 *
 * "That's right" approves two onboarding proposals; the worker runs them after
 * the five-second undo window (proposals/lifecycle.ts UNDO_WINDOW_MS). The one
 * Undo on the saving screen takes back the WHOLE approval, or nothing:
 *
 *   every listed proposal  approved -> undone   (the transition POST
 *                                                /api/proposals/:id/undo makes)
 *   the draft              approved -> draft    (proposal_ids [], approved_at
 *                                                null, version + 1)
 *
 * so the owner is back on the read-back with every answer intact.
 *
 * One tenant transaction that locks, then decides, then writes, all inside
 * `updateLocked` (requireStatus `approved`, the caller's `expectedVersion`), so
 * the draft row is locked once and the draft UPDATE is the last write:
 *
 *   1. the draft row lock; a draft already back in `draft` (a double tap, or
 *      another tab got there first) is DraftNotApprovedError (409
 *      DRAFT_NOT_APPROVED);
 *   2. the version: anything but the row's is DraftVersionConflictError (409
 *      VERSION_CONFLICT naming both), and the proposals are never read. The
 *      version binds the tap to the approval attempt its screen showed: an
 *      approved draft's version moves only when undo/reset/reopen take it out of
 *      `approved`, when a retry opens a new window on it, and on every
 *      approval, so a stale tab can never undo a newer approval or a retry it
 *      did not render;
 *   3. the set, `SELECT ... FOR UPDATE` in id order (locked-set.ts), and the
 *      decision: EVERY listed proposal must exist and be `approved` (else 409
 *      DRAFT_UNDO_REFUSED, statuses in `details`), and inside its window by
 *      this clock with no margin (else 409 UNDO_WINDOW_CLOSED). A set the inbox
 *      already split (one `undone`, `rejected`, `expired`) is the whole-draft
 *      reset's, not a looser undo; an executed member is the inbox's
 *      per-proposal undo or Settings.
 *   4. only then the writes: each member to `undone` (one `proposal.undone`
 *      each), the draft back to `draft`, one `onboarding.draft_undone`.
 *
 * The row locks are what close the race at the five-second boundary: the
 * worker claims with `UPDATE ... WHERE id = $1 AND status = 'approved'`, so a
 * claim that arrives while undo holds the locks waits and then matches nothing
 * (the rows are `undone`), and a claim that committed first reads as
 * `executing` here and refuses the undo. The draft therefore never returns to
 * editing while a listed proposal is applying or has applied.
 */
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import { logProposalEvent } from '../../proposals/audit';
import { isInUndoWindow, transitionProposal } from '../../proposals/lifecycle';
import type { ProposalRepository } from '../../proposals/proposal';
import type { Role } from '../../auth/rbac';
import { ConflictError } from '../../shared/errors';
import { MISSING_PROPOSAL } from '../derive-status';
import { lockDraftProposalSet, lockedSetStatuses, type LockedDraftSet } from './locked-set';
import type { OnboardingDraft, OnboardingDraftRepository } from './repository';

export interface UndoDraftDeps {
  draftRepo: OnboardingDraftRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  /** The clock the undo window is judged by; injectable for tests. */
  now?: () => Date;
}

export interface UndoDraftResult {
  /** The draft, editable again, at its new version. */
  draft: OnboardingDraft;
  /** The proposals that were taken back (ascending id order). */
  undoneProposalIds: string[];
}

/** How an owner reads each status that means the whole approval can no longer be taken back. */
const REFUSED_PHRASE: Record<string, string> = {
  executing: 'is already being saved',
  executed: 'is already saved',
  execution_failed: 'did not save and needs another try',
  undone: 'was already taken back',
  rejected: 'was declined',
  expired: 'expired',
  draft: 'was never confirmed',
  ready_for_review: 'is still waiting for review',
  [MISSING_PROPOSAL]: 'is missing',
};

function undoRefused(set: LockedDraftSet, statuses: string[]): ConflictError {
  const blockers = statuses.filter((s) => s !== 'approved');
  const reasons = [...new Set(blockers.map((b) => REFUSED_PHRASE[b] ?? 'has changed'))];
  const why = reasons.length > 0 ? reasons.map((r) => `part of it ${r}`).join(' and ') : 'there is nothing to take back';
  return new ConflictError(`DRAFT_UNDO_REFUSED: This can't be undone all at once any more, because ${why}.`, {
    statuses,
    expected: set.expected,
  });
}

function windowClosed(): ConflictError {
  return new ConflictError(
    "UNDO_WINDOW_CLOSED: It's too late to undo this. Your choices are being saved, and you can change any of them in Settings.",
  );
}

/**
 * The whole-set rule undo applies (and the reset reuses for its approved
 * members): null when every listed proposal exists, is `approved` and is inside
 * its window at `nowMs`; otherwise the refusal to throw.
 */
export function wholeSetUndoRefusal(set: LockedDraftSet, nowMs: number): ConflictError | null {
  const statuses = lockedSetStatuses(set);
  if (set.expected <= 0 || statuses.some((s) => s !== 'approved')) return undoRefused(set, statuses);
  if (!set.members.every((p) => isInUndoWindow(p, nowMs))) return windowClosed();
  return null;
}

export async function undoApprovedDraft(
  deps: UndoDraftDeps,
  tenantId: string,
  actor: { userId: string; role: Role },
  opts: { expectedVersion: number },
): Promise<UndoDraftResult> {
  const { draftRepo, proposalRepo, auditRepo } = deps;
  const now = deps.now ?? (() => new Date());
  let undone: string[] = [];

  const draft = await draftRepo.updateLocked(
    tenantId,
    { requireStatus: 'approved', expectedVersion: opts.expectedVersion },
    async (row) => {
      const set = await lockDraftProposalSet(proposalRepo, tenantId, row.proposalIds);
      const refusal = wholeSetUndoRefusal(set, now().getTime());
      if (refusal) throw refusal;

      // Decided: every member is approved, in its window, and locked. Revert them all.
      for (const p of set.members) {
        const next = transitionProposal(p, 'undone', actor.userId);
        const updated = await proposalRepo.updateStatusIf(tenantId, p.id, ['approved'], 'undone', {
          undoneAt: next.undoneAt,
          undoneBy: next.undoneBy,
        });
        // Cannot miss under the row lock; fail closed (the request rolls back) rather than half-undo.
        if (!updated) throw new ConflictError(`DRAFT_UNDO_REFUSED: part of it changed while it was being undone`, { proposalId: p.id });
        await logProposalEvent(auditRepo, updated, 'proposal.undone', { id: actor.userId, role: actor.role }, { draftId: row.id });
      }
      undone = set.members.map((p) => p.id);
      return { status: 'draft', proposalIds: [], approvedAt: null };
    },
  );

  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'onboarding.draft_undone',
      entityType: 'onboarding_draft',
      entityId: draft.id,
      metadata: {
        proposalIds: undone,
        // updateLocked bumps by exactly one from the locked row's version.
        draftVersionBefore: draft.version - 1,
        draftVersionAfter: draft.version,
      },
    }),
  );
  return { draft, undoneProposalIds: undone };
}
