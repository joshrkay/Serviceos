/**
 * Whole-draft reset — "Start over": the way out of an approval that can no
 * longer finish as one unit.
 *
 * The inbox can undo ONE member of the approved pair, a member can fail beside
 * one that will never run, or a member can lapse. Undo then refuses (it wants
 * every member `approved`), retry refuses (DRAFT_RETRY_UNSAFE), and the status
 * reads `stopped`. Reset is the locked reconciliation for that set. It is its
 * own endpoint, not a looser undo, on purpose: the saving screen's Undo keeps
 * meaning "take back the whole approval I just made", and the audit trail tells
 * an owner's undo (`onboarding.draft_undone`) from a clean-up after a partial
 * stop (`onboarding.draft_reset`). It accepts a superset of what undo accepts
 * and shares its locked read (locked-set.ts).
 *
 * One tenant transaction that locks, then decides, then writes, all inside
 * `updateLocked` (requireStatus `approved`, the caller's `expectedVersion`), so
 * the draft row is locked once and the draft UPDATE is the last write:
 *
 *   1. the draft row lock; a draft already back in `draft` (a double tap, or
 *      another tab got there first) is DraftNotApprovedError (409
 *      DRAFT_NOT_APPROVED); a stale `expectedVersion` (a tab that rendered an
 *      earlier approval, since replaced) is DraftVersionConflictError (409
 *      VERSION_CONFLICT), so a reset can never revert an approval its caller
 *      never saw, and the proposals are never read;
 *   2. the set, `SELECT ... FOR UPDATE` in id order (locked-set.ts);
 *   3. the decision, from the locked rows only, by `resetBlocker` (the same
 *      rule the status's `recovery` hint applies, a second early): any member
 *      `executed` is 409 DRAFT_RESET_REFUSED reason `applied` (that work is
 *      live; Settings finishes it), any `executing` is DRAFT_RESET_REFUSED reason
 *      `executing` (it is landing now), an `approved` member past its window is
 *      409 UNDO_WINDOW_CLOSED. A refusal has written nothing;
 *   4. only then the writes, every member write before `proposal_ids` is
 *      cleared: each `approved` member -> `undone` (the transition POST
 *      /api/proposals/:id/undo makes, one `proposal.undone` each); each member
 *      still `draft` / `ready_for_review` -> `expired` (one `proposal.expired`
 *      each, `reason: 'superseded_by_reset'`): such a card is live in the
 *      inbox, which lists those statuses by status, not by draft membership,
 *      and a later tap would apply its stale settings beside the fresh pair the
 *      next approval mints. `expired`, not `rejected`: it has no way back to
 *      `approved` and records no owner decision nobody made. Every other member
 *      (`undone`, `rejected`, `expired`, `execution_failed`) is left exactly as
 *      it is. Every member write is conditional and one that matches nothing
 *      throws, so the request rolls back whole. Then the draft returns to
 *      `draft` with its choices intact, `proposal_ids = []`, `version + 1`, and
 *      one `onboarding.draft_reset` names what was reverted, what superseded,
 *      and the `{ id, status }` of every other member.
 *
 * Reset mints and re-approves nothing; the next approval mints a fresh pair.
 * The row locks close the same boundary race as undo: a worker claim
 * (`UPDATE ... WHERE id = $1 AND status = 'approved'`) arriving while reset
 * holds the set waits, then matches nothing (the row is `undone`); one that
 * committed first reads as `executing` here and refuses the reset. An inbox
 * approve of a leftover arriving while reset holds it waits, then its
 * conditional write (proposals/actions.ts) matches nothing and it answers the
 * lifecycle 409 from `expired`. The draft therefore never returns to editing
 * while a listed proposal is applying or has applied.
 *
 * Reopen (U6) keeps its own precondition (every proposal `executed`), so a
 * reset set is never reopened on top of rows that did not run.
 */
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import { logProposalEvent } from '../../proposals/audit';
import { transitionProposal } from '../../proposals/lifecycle';
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import type { Role } from '../../auth/rbac';
import { ConflictError } from '../../shared/errors';
import { MISSING_PROPOSAL, resetBlocker, type DraftResetBlocker } from '../derive-status';
import { lockDraftProposalSet, lockedSetFact, lockedSetStatuses, type LockedDraftSet } from './locked-set';
import type { OnboardingDraft, OnboardingDraftRepository } from './repository';

/** The reason a superseded leftover carries on its `proposal.expired` row and on `onboarding.draft_reset`. */
export const SUPERSEDED_BY_RESET = 'superseded_by_reset';

/** The pre-approval statuses a reset expires instead of leaving live in the inbox. */
const SUPERSEDABLE: Proposal['status'][] = ['draft', 'ready_for_review'];

export interface ResetDraftDeps {
  draftRepo: OnboardingDraftRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  /** The clock the undo window is judged by; injectable for tests. */
  now?: () => Date;
}

export interface ResetDraftResult {
  /** The draft, editable again, at its new version, with its choices intact. */
  draft: OnboardingDraft;
  /** Members that were `approved` inside their window and are now `undone` (ascending id). */
  revertedProposalIds: string[];
  /** Leftovers that were `draft` / `ready_for_review` and are now `expired` (ascending id). */
  supersededProposalIds: string[];
  /** Every other listed member, as it was left (a listed id with no row is `missing`). */
  others: { id: string; status: string }[];
}

/**
 * The owner-facing 409s. `CODE: plain sentence`; the raw statuses and the
 * machine reason ride in `details` for the shell, support and tests.
 */
function resetRefused(blocker: DraftResetBlocker, set: LockedDraftSet): ConflictError {
  const details = { statuses: lockedSetStatuses(set), expected: set.expected };
  if (blocker === 'window_closed') {
    return new ConflictError(
      "UNDO_WINDOW_CLOSED: It's too late to start over. Your choices are being saved, and you can change any of them in Settings.",
      details,
    );
  }
  if (blocker === 'executing') {
    return new ConflictError(
      'DRAFT_RESET_REFUSED: Part of your setup is being saved right now, so it can\'t start over yet. Give it a moment.',
      { ...details, reason: 'executing' },
    );
  }
  return new ConflictError(
    "DRAFT_RESET_REFUSED: Part of your setup is already saved, so it can't start over from here. You can finish or change it in Settings.",
    { ...details, reason: 'applied' },
  );
}

export async function resetApprovedDraft(
  deps: ResetDraftDeps,
  tenantId: string,
  actor: { userId: string; role: Role },
  opts: { expectedVersion: number },
): Promise<ResetDraftResult> {
  const { draftRepo, proposalRepo, auditRepo } = deps;
  const now = deps.now ?? (() => new Date());
  let reverted: string[] = [];
  let superseded: string[] = [];
  let others: { id: string; status: string }[] = [];

  const draft = await draftRepo.updateLocked(
    tenantId,
    { requireStatus: 'approved', expectedVersion: opts.expectedVersion },
    async (row) => {
      const set = await lockDraftProposalSet(proposalRepo, tenantId, row.proposalIds);
      const blocker = resetBlocker(lockedSetFact(set), now().getTime());
      if (blocker) throw resetRefused(blocker, set);

      // Decided, from the locked rows: nothing applied or applying, every approved member inside its window.
      const toRevert = set.members.filter((p) => p.status === 'approved');
      const toSupersede = set.members.filter((p) => SUPERSEDABLE.includes(p.status));
      const present = new Set(set.members.map((p) => p.id));

      for (const p of toRevert) {
        const next = transitionProposal(p, 'undone', actor.userId);
        const updated = await proposalRepo.updateStatusIf(tenantId, p.id, ['approved'], 'undone', {
          undoneAt: next.undoneAt,
          undoneBy: next.undoneBy,
        });
        // Cannot miss under the row lock; fail closed (the request rolls back) rather than half-reset.
        if (!updated) throw new ConflictError('DRAFT_RESET_REFUSED: Part of your setup changed while starting over. Try again.', { proposalId: p.id });
        await logProposalEvent(auditRepo, updated, 'proposal.undone', { id: actor.userId, role: actor.role }, { draftId: row.id, via: 'reset' });
      }
      for (const p of toSupersede) {
        // Asserts the lifecycle edge (draft / ready_for_review -> expired) before writing.
        transitionProposal(p, 'expired', actor.userId);
        const updated = await proposalRepo.updateStatusIf(tenantId, p.id, SUPERSEDABLE, 'expired');
        if (!updated) throw new ConflictError('DRAFT_RESET_REFUSED: Part of your setup changed while starting over. Try again.', { proposalId: p.id });
        await logProposalEvent(
          auditRepo,
          updated,
          'proposal.expired',
          { id: actor.userId, role: actor.role },
          { reason: SUPERSEDED_BY_RESET, draftId: row.id },
        );
      }

      reverted = toRevert.map((p) => p.id);
      superseded = toSupersede.map((p) => p.id);
      const touched = new Set([...reverted, ...superseded]);
      others = [
        ...set.members.filter((p) => !touched.has(p.id)).map((p) => ({ id: p.id, status: p.status as string })),
        ...[...row.proposalIds]
          .sort()
          .filter((id) => !present.has(id))
          .map((id) => ({ id, status: MISSING_PROPOSAL })),
      ];
      return { status: 'draft', proposalIds: [], approvedAt: null };
    },
  );

  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'onboarding.draft_reset',
      entityType: 'onboarding_draft',
      entityId: draft.id,
      metadata: {
        reverted,
        superseded,
        others,
        supersededReason: SUPERSEDED_BY_RESET,
        // updateLocked bumps by exactly one from the locked row's version.
        draftVersionBefore: draft.version - 1,
        draftVersionAfter: draft.version,
      },
    }),
  );
  return { draft, revertedProposalIds: reverted, supersededProposalIds: superseded, others };
}
