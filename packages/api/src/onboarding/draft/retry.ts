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
 * draft row (`getForTenantForUpdate`), so two retries (and a later undo) serialise:
 * the second sees the first's committed outcome and answers 409
 * DRAFT_RETRY_NOTHING_FAILED. Any thrown error rolls the whole request back, so a
 * proposal is never left half-reset in `draft`.
 *
 * The draft row itself is not written: it is frozen once approved and `version`
 * is the choice-staging compare-and-swap token.
 *
 * What retry refuses: it re-queues ONLY the failed proposal, so it is safe only
 * when the pair can still complete. If any listed proposal is outside
 * approved/executing/executed/execution_failed (`undone` is terminal in
 * lifecycle.ts; `rejected`, `expired`, `draft` never run on their own) or its row
 * is gone, re-queueing just the failed one would, after its fresh undo window,
 * execute it ALONE: half the approved configuration live, the other half dead,
 * and Settings the only way back. That set answers 409 DRAFT_RETRY_UNSAFE and
 * nothing is changed (a whole-draft reset or Settings is the way out). The status
 * says the same: such a draft derives `execution: 'stopped'` even when a sibling
 * failed (derive-status.ts, same `retryBlockingStatuses` check), so the shell
 * never offers a Retry that cannot work. `failed + executed` and
 * `failed + approved` stay retryable: the retry completes the pair.
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
import { MISSING_PROPOSAL, retryBlockingStatuses } from '../derive-status';
import type { OnboardingDraft, OnboardingDraftRepository } from './repository';

/** Audit rows carry the old failure for the timeline, never an unbounded string. */
const PREVIOUS_ERROR_MAX_CHARS = 500;

export interface RetryDraftDeps {
  draftRepo: OnboardingDraftRepository;
  proposalRepo: ProposalRepository;
  auditRepo: AuditRepository;
  approvalOptions?: ApprovalOptions;
}

export interface RetryDraftResult {
  draft: OnboardingDraft;
  /** The proposals that were re-queued (ascending id order). */
  retriedProposalIds: string[];
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
 * words and the way out; the raw statuses ride in `details` for support and tests.
 */
function retryUnsafe(blockers: string[], statuses: string[], expected: number): ConflictError {
  const reasons = [...new Set(blockers.map((b) => BLOCKER_PHRASE[b] ?? 'is not in a state that can be retried'))];
  return new ConflictError(
    `DRAFT_RETRY_UNSAFE: Retrying could leave your setup half saved, because ${reasons.map((r) => `part of it ${r}`).join(' and ')}. ` +
      'Reset the whole setup, or finish it from Settings.',
    { statuses, expected },
  );
}

export async function retryFailedDraftProposals(
  deps: RetryDraftDeps,
  tenantId: string,
  actor: { userId: string; role: Role },
): Promise<RetryDraftResult> {
  const { draftRepo, proposalRepo, auditRepo } = deps;

  const draft = await draftRepo.getForTenantForUpdate(tenantId);
  if (!draft) throw new NotFoundError('OnboardingDraft', tenantId);
  if (draft.status !== 'approved') {
    throw new ConflictError('DRAFT_NOT_APPROVED: the draft has not been approved, so there is nothing to retry');
  }

  const found: Proposal[] = [];
  for (const id of [...draft.proposalIds].sort()) {
    const p = await proposalRepo.findById(tenantId, id);
    if (p) found.push(p);
  }
  const statuses = found.map((p) => p.status);

  // Check order: not approved (above), then unsafe, then nothing failed. Unsafe
  // comes before nothing-failed because a set with a member retry cannot recover
  // is never merely "nothing to do": the owner needs the way out (reset or
  // Settings), and it matches the status, which says `stopped` for exactly these
  // sets whether or not anything failed. NOTHING_FAILED is left for the benign
  // sets (everything approved/executing/executed), e.g. the loser of a race
  // between two retries. Nothing has been written when either one throws.
  const blockers = retryBlockingStatuses({ expected: draft.proposalIds.length, statuses });
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

  for (const id of moved) {
    const requeued = await proposalRepo.findById(tenantId, id);
    if (!requeued) throw new NotFoundError('Proposal', id);
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
      metadata: { proposalIds: moved, draftVersion: draft.version },
    }),
  );

  return { draft, retriedProposalIds: moved };
}
