/**
 * Retry after a failed execution — the way out of the wait screen.
 *
 * "That's right" approves two onboarding proposals and the execution worker runs
 * them after the undo window. A failed execution is terminal on the API
 * (`execution_failed`, no automatic retry), so without this the owner waits
 * forever. Retry re-queues exactly the proposals that failed, through the same
 * path an approval takes:
 *
 *   execution_failed -> draft   (ProposalRepository.resetFailedForRetry: one
 *                                conditional write that also clears the stale
 *                                approvedAt / error / claim / retry count)
 *   draft -> approved           (approveProposalsBatch, the helper POST /approve
 *                                and the inbox use, with a FRESH approvedAt)
 *
 * so the worker picks them up after a fresh undo window. Proposals that are not
 * execution_failed are left alone. There is no parallel transition: lifecycle.ts
 * allows both edges and `canTransition` is asserted before every reset.
 *
 * Runs inside the `/api` request transaction. The first statement locks the
 * draft row (`getForTenantForUpdate`), so two retries (and an undo) serialise:
 * the second sees the first's committed outcome and answers 409
 * VERSION_CONFLICT when it sent the version it rendered (the first moved it), or
 * DRAFT_RETRY_NOTHING_FAILED when it sent none. Guard order: DRAFT_NOT_APPROVED,
 * then a stale `expectedVersion` (VERSION_CONFLICT, before the set is read), then
 * DRAFT_RETRY_UNSAFE, then DRAFT_RETRY_NOTHING_FAILED. The set itself is read
 * through the ordered `FOR UPDATE` of locked-set.ts, the same read undo and reset
 * use, so an inbox undo of a sibling cannot land between the safety check and
 * the re-queue. Any thrown error rolls the whole request back, so a proposal is
 * never left half-reset in `draft`.
 *
 * A successful retry opens a NEW approval attempt: the re-approval stamps a
 * fresh `approvedAt` and so a fresh undo window, and the draft `version` moves
 * with it (`markRetried`, one compare-and-swap on the version read under the
 * lock, after every guard has passed and the proposals are re-approved). The
 * version therefore names one approval attempt. A tab that rendered the
 * original approval keeps the old version, so anything it later sends with it
 * (a re-tapped approve today, an undo or reset later) is refused as stale
 * instead of acting on a retry it never rendered. Nothing else about the row is
 * written, and a refused retry (any of the 409s) writes nothing at all.
 *
 * What retry refuses: it re-queues ONLY the failed proposal, so it is safe only
 * when the pair can still complete. If any listed proposal is outside
 * approved/executing/executed/execution_failed (`undone` is terminal in
 * lifecycle.ts; `rejected`, `expired`, `draft` never run on their own) or its row
 * is gone, re-queueing just the failed one would, after its fresh undo window,
 * execute it ALONE: half the approved configuration live, the other half dead,
 * and Settings the only way back. That set answers 409 DRAFT_RETRY_UNSAFE and
 * nothing is changed. The status says the same: such a draft derives
 * `execution: 'stopped'` even when a sibling failed (derive-status.ts, same
 * `retryBlockingStatuses` check), so the shell never offers a Retry that cannot
 * work. The way out of that set is the whole-draft reset (plan U9), not the
 * whole-draft undo, which refuses it (undo wants every member `approved` inside
 * its window); the status's derived `recovery` says whether the reset can still
 * run (`'reset'`) or only Settings can finish the set (`'settings'`, once a
 * member executed or an approved one is past its window). `failed + executed`
 * and `failed + approved` stay retryable: the retry completes the pair.
 */
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import { approveProposalsBatch } from '../../proposals/actions';
import type { ApprovalOptions } from '../../proposals/approval-reference-checks';
import { logProposalEvent } from '../../proposals/audit';
import { canTransition } from '../../proposals/lifecycle';
import type { Proposal, ProposalRepository } from '../../proposals/proposal';
import type { Role } from '../../auth/rbac';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { MISSING_PROPOSAL, deriveDraftUndoable, retryBlockingStatuses } from '../derive-status';
import { lockDraftProposalSet, lockedSetFact } from './locked-set';
import { DraftVersionConflictError, type OnboardingDraft, type OnboardingDraftRepository } from './repository';

/** Audit rows carry the old failure for the timeline, never an unbounded string. */
const PREVIOUS_ERROR_MAX_CHARS = 500;

export interface RetryDraftDeps {
  draftRepo: OnboardingDraftRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  approvalOptions?: ApprovalOptions;
  /** The clock `undoable` is judged by; injectable for tests. */
  now?: () => Date;
}

export interface RetryDraftResult {
  /** The draft at its new version: the approval attempt this retry opened. */
  draft: OnboardingDraft;
  /** The proposals that were re-queued (ascending id order). */
  retriedProposalIds: string[];
  /**
   * Whether the whole-draft undo can take back the set as this retry left it:
   * the status's own `undoable` predicate over the post-retry set. False after a
   * partial retry (only the re-queued member has a fresh window), true after a
   * full-set retry while the new window is open.
   */
  undoable: boolean;
}

function nothingFailed(statuses: string[]): ConflictError {
  return new ConflictError(
    `DRAFT_RETRY_NOTHING_FAILED: no proposal is in execution_failed (statuses: ${statuses.join(', ') || 'none'})`,
    { statuses },
  );
}

/** How an owner reads each status that makes a set unsafe to retry (never the raw status). */
const BLOCKER_PHRASE: Record<string, string> = {
  undone: 'was undone',
  rejected: 'was declined',
  expired: 'expired',
  draft: 'was never approved',
  ready_for_review: 'is still waiting for review',
  [MISSING_PROPOSAL]: 'is missing',
};

/**
 * The owner-facing 409 for a set retry must not touch. The sentence is plain
 * words and the two ways out the shell offers: Start over (the whole-draft
 * reset, POST /draft/reset, which accepts this set while nothing in it ran) or
 * Settings (once part of it did). The raw statuses ride in `details` for
 * support and tests.
 */
function retryUnsafe(blockers: string[], statuses: string[], expected: number): ConflictError {
  const reasons = [...new Set(blockers.map((b) => BLOCKER_PHRASE[b] ?? 'is not in a state that can be retried'))];
  return new ConflictError(
    `DRAFT_RETRY_UNSAFE: Retrying could leave your setup half saved, because ${reasons.map((r) => `part of it ${r}`).join(' and ')}. ` +
      'Start over to set it up again, or finish it from Settings.',
    { statuses, expected },
  );
}

export async function retryFailedDraftProposals(
  deps: RetryDraftDeps,
  tenantId: string,
  actor: { userId: string; role: Role },
  opts: { expectedVersion?: number } = {},
): Promise<RetryDraftResult> {
  const { draftRepo, proposalRepo, auditRepo } = deps;
  const now = deps.now ?? (() => new Date());

  const draft = await draftRepo.getForTenantForUpdate(tenantId);
  if (!draft) throw new NotFoundError('OnboardingDraft', tenantId);
  if (draft.status !== 'approved') {
    throw new ConflictError('DRAFT_NOT_APPROVED: the draft has not been approved, so there is nothing to retry');
  }
  // The version binds the tap to the approval attempt the failed screen showed:
  // without it, a tab still showing the failure of approval 1 could re-queue a
  // newer pair another tab approved since. Checked under the lock, before the set
  // is read, so a stale tab is refused with nothing read or written. Optional
  // until every client sends it (S4-10).
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== draft.version) {
    throw new DraftVersionConflictError(opts.expectedVersion, draft.version);
  }

  // The whole set, locked in id order (locked-set.ts): an inbox undo of a sibling
  // or a worker claim cannot land between the safety check and the re-queue.
  const set = await lockDraftProposalSet(proposalRepo, tenantId, draft.proposalIds);
  const found: Proposal[] = set.members;
  const statuses = found.map((p) => p.status);

  // Check order: not approved and stale version (above), then unsafe, then nothing failed. Unsafe
  // comes before nothing-failed because a set with a member retry cannot recover
  // is never merely "nothing to do": the owner needs the way out (the inbox or
  // Settings), and it matches the status, which says `stopped` for exactly these
  // sets whether or not anything failed. NOTHING_FAILED is left for the benign
  // sets (everything approved/executing/executed), e.g. the loser of a race
  // between two retries. Nothing has been written when either one throws.
  const blockers = retryBlockingStatuses(lockedSetFact(set));
  if (blockers.length > 0) throw retryUnsafe(blockers, statuses, draft.proposalIds.length);

  const failed = found.filter((p) => p.status === 'execution_failed');
  if (failed.length === 0) throw nothingFailed(statuses);

  // The edge retry relies on. If lifecycle.ts ever drops it this fails loudly
  // instead of resetting rows by a path the lifecycle no longer allows.
  if (!canTransition('execution_failed', 'draft') || !canTransition('draft', 'approved')) {
    throw new ConflictError('DRAFT_RETRY_FAILED: the proposal lifecycle no longer allows execution_failed -> draft -> approved');
  }

  const previousError = new Map<string, string | undefined>();
  const moved: string[] = [];
  for (const p of failed) {
    const reset = await proposalRepo.resetFailedForRetry(tenantId, p.id);
    // null: another path moved the row after our read. Leave it to that path.
    if (!reset) continue;
    previousError.set(p.id, p.executionError);
    moved.push(p.id);
  }
  if (moved.length === 0) throw nothingFailed(statuses);

  const result = await approveProposalsBatch(
    proposalRepo,
    tenantId,
    moved,
    actor.userId,
    actor.role,
    auditRepo,
    'ui',
    deps.approvalOptions,
  );
  if (result.failed.length > 0) {
    // Throwing turns the response into a 409 and the request transaction rolls
    // back every reset above: the rows stay execution_failed.
    const reasons = result.failed.map((f) => `${f.id}: ${f.reason}`).join('; ');
    throw new ConflictError(`DRAFT_RETRY_FAILED: ${reasons}`);
  }

  // Every guard passed and the re-approval succeeded: this is a new attempt, so
  // move the version. Under the row lock taken above, `draft.version` is current;
  // the compare-and-swap is the second guard. A throw here rolls the request back.
  const retried = await draftRepo.markRetried(tenantId, draft.version);

  const requeuedById = new Map<string, Proposal>();
  for (const id of moved) {
    const requeued = await proposalRepo.findById(tenantId, id);
    if (!requeued) throw new NotFoundError('Proposal', id);
    requeuedById.set(id, requeued);
    await logProposalEvent(
      auditRepo,
      requeued,
      'proposal.retried',
      { id: actor.userId, role: actor.role },
      {
        draftId: draft.id,
        previousExecutionError: previousError.get(id)?.slice(0, PREVIOUS_ERROR_MAX_CHARS),
      },
    );
  }

  await auditRepo.create(
    createAuditEvent({
      tenantId,
      actorId: actor.userId,
      actorRole: actor.role,
      eventType: 'onboarding.draft_retry',
      entityType: 'onboarding_draft',
      entityId: draft.id,
      metadata: { proposalIds: moved, draftVersionBefore: draft.version, draftVersionAfter: retried.version },
    }),
  );

  // The set as this retry left it: re-queued members as re-read, the rest as locked.
  const after = lockedSetFact({ expected: set.expected, members: found.map((p) => requeuedById.get(p.id) ?? p) });
  const undoable = deriveDraftUndoable('approved', after, now()) ?? false;

  return { draft: retried, retriedProposalIds: moved, undoable };
}
