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
 * What retry cannot do: `undone` is terminal in lifecycle.ts, so a proposal the
 * owner undid from the inbox is not retryable and answers the same 409.
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
  const failed = found.filter((p) => p.status === 'execution_failed');
  if (failed.length === 0) throw nothingFailed(found.map((p) => p.status));

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
  if (moved.length === 0) throw nothingFailed(found.map((p) => p.status));

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
