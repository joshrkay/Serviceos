import { Proposal, ProposalRepository, missingFieldsFor, actionClassForProposalType, createProposal, isExpirableProposalType } from './proposal';
import { transitionProposal, isInUndoWindow, UNDO_WINDOW_MS } from './lifecycle';
import { validateProposalPayload } from './contracts';
import { Role, hasPermission } from '../auth/rbac';
import { AppError, ConflictError, ForbiddenError, ValidationError, NotFoundError } from '../shared/errors';
import { AppointmentRepository, updateAppointment } from '../appointments/appointment';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { logProposalEvent } from './audit';
import type { CatalogItemRepository } from '../catalog/catalog-item';
import { recomputePricedProposalOnEdit } from '../ai/tasks/recompute-priced-proposal';
import { confidenceMetaBlocksAutoApprove } from './auto-approve';
import { chainMetaFor } from './chain';
import { undoCorrectionLesson } from '../learning/corrections/apply-undo';
import type { CorrectionLessonRepository } from '../learning/corrections/correction-lesson';
import type { ConfigPorts } from '../learning/corrections/lesson-applicator';
import { createLogger } from '../logging/logger';
import { computeCorrections } from './corrections/correction';
import type { CorrectionRepository } from './corrections/correction';

const logger = createLogger({
  service: 'proposals.actions',
  environment: process.env.NODE_ENV || 'development',
});

/**
 * N-009 / P2-038 — optional correction-loop reversal wired into `undoProposal`.
 * When supplied, undoing a proposal reverses every structured lesson that
 * proposal recorded (and the config each cascaded). Failure-soft: a throw is
 * logged and swallowed so it can never block the proposal undo itself.
 */
export interface UndoCorrectionLoopDeps {
  lessonRepo: CorrectionLessonRepository;
  ports: ConfigPorts;
}

export interface BatchApproveResult {
  approved: string[];
  failed: { id: string; reason: string }[];
}

export interface ApproveChainSetResult {
  approved: Proposal[];
  skipped: {
    id: string;
    reason:
      | 'non_capture'
      | 'not_reviewable'
      | 'low_confidence'
      | 'pending_edit'
      | 'missing_fields'
      | 'error';
  }[];
}

export interface ChainSetApprovalSummary {
  approvedCount: number;
  /** Skips that require a separate follow-up; excludes already non-reviewable siblings. */
  followCount: number;
  skipped: ApproveChainSetResult['skipped'];
}

export type PendingEditChecker = (tenantId: string, proposalId: string) => Promise<boolean>;

export function summarizeChainSetResult(result: ApproveChainSetResult): ChainSetApprovalSummary {
  return {
    approvedCount: result.approved.length,
    followCount: result.skipped.filter((skip) => skip.reason !== 'not_reviewable').length,
    skipped: result.skipped,
  };
}

export function formatChainSetApprovalMessage(
  summary: ChainSetApprovalSummary,
  fallbackMessage: string,
): string {
  if (summary.approvedCount > 1 || summary.followCount > 0) {
    const actionWord = summary.approvedCount === 1 ? 'action' : 'actions';
    const follows =
      summary.followCount > 0
        ? ` — ${summary.followCount} ${summary.followCount === 1 ? 'follows' : 'follow'} separately.`
        : '.';
    return `Approved ${summary.approvedCount} linked ${actionWord}${follows}`;
  }
  return fallbackMessage;
}

/**
 * RV-073 — the transport an approval/rejection decision arrived on.
 * Recorded in the `proposal.approved` / `proposal.rejected` audit-event
 * metadata so the timeline can answer "HOW was this approved?".
 *
 *   'ui'      — dashboard / inbox screen-tap (routes/proposals.ts)
 *   'sms'     — inbound SMS reply Y/N (proposals/sms/reply-handler.ts)
 *   'one_tap' — HMAC one-tap link (routes/one-tap-approve.ts)
 *   'voice'   — spoken approval on a recognized owner line
 *               (caller-ID match; see approver-identity.ts) (RV-071)
 *
 * When absent, the channel key is OMITTED from the audit metadata
 * (rather than defaulting to 'ui') — least invasive for existing audit
 * consumers and truthful for legacy call sites that have not been
 * updated to declare their transport.
 */
export type ApprovalChannel = 'ui' | 'sms' | 'one_tap' | 'voice';

/**
 * P2-035 — Batch proposal approval (APPROVE ALL).
 *
 * Iterates the IDs and delegates to `approveProposal` per ID. There is NO
 * cross-proposal transaction: partial success is the desired outcome (the
 * P6-028 "tech goes out, four customers need rescheduling" scenario should
 * approve everything the owner can approve and surface the rest as
 * `failed` rather than rolling everything back).
 *
 * Each successful approval emits its own `proposal.approved` audit event
 * through the existing `approveProposal` helper — there is no separate
 * "batch" audit row by design. Downstream consumers (timeline, notifier)
 * index on the singular events, and collapsing here would silently break
 * them.
 *
 * RBAC is enforced per-proposal inside `approveProposal`. The route also
 * gates with `requirePermission('proposals:approve')` so unauthorized
 * callers 403 at the boundary; the per-proposal check is the second
 * layer that survives a future route refactor.
 */
export async function approveProposalsBatch(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalIds: string[],
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
  channel?: ApprovalChannel,
): Promise<BatchApproveResult> {
  const approved: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const id of proposalIds) {
    try {
      await approveProposal(proposalRepo, tenantId, id, actorId, actorRole, auditRepo, channel);
      approved.push(id);
    } catch (err) {
      // Surface the error code when available (e.g. NOT_FOUND, FORBIDDEN,
      // VALIDATION_ERROR). Callers — both the HTTP layer and the inbox UI —
      // pivot on these. Falls back to message for non-AppError throwables.
      const reason =
        err instanceof AppError
          ? err.code
          : err instanceof Error
            ? err.message
            : String(err);
      failed.push({ id, reason });
    }
  }

  return { approved, failed };
}

export async function approveProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
  channel?: ApprovalChannel,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // A proposal with unfilled required fields can't be approved — the
  // operator must resolve the gaps (via editProposal) first. This guard
  // matters now that drafts are directly approvable from the inbox:
  // without it a half-extracted voice payload could be approved straight
  // from 'draft'. Chain-ref fields are intentionally NOT in missingFields
  // (they resolve at execution time), so a chained dependent stays
  // approvable.
  const missing = missingFieldsFor(proposal);
  if (missing.length > 0) {
    throw new ValidationError(
      `Cannot approve proposal with unfilled required fields: ${missing.join(', ')}`,
      { missingFields: missing },
    );
  }

  const transitioned = transitionProposal(proposal, 'approved', actorId);

  // D9 undo window: stamp `approvedAt` on the persisted row so the
  // executor and undoProposal can agree on when the window opened.
  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'approved', {
    approvedAt: transitioned.approvedAt,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the approval through the existing helper. The
  // auditRepo arg is optional so legacy call-sites (tests that don't
  // care about audit rows) compile unchanged; the router-factory always
  // passes a real repo in production.
  if (auditRepo) {
    await logProposalEvent(
      auditRepo,
      updated,
      'proposal.approved',
      {
        id: actorId,
        role: actorRole,
      },
      // RV-073 — record HOW the approval arrived. Omitted entirely when
      // the call site has not declared a channel (legacy behavior).
      channel ? { channel } : undefined,
    );
  }

  return updated;
}

function isReviewableForChainSet(proposal: Proposal): boolean {
  return proposal.status === 'draft' || proposal.status === 'ready_for_review';
}

/**
 * Approve a chain head plus eligible capture-class chain siblings.
 *
 * Execution correctness does not depend on this approval order:
 * `resolveChainReferences` blocks a dependent until its parent has executed.
 * We still approve in `chainIndex` order so audit rows and future execution
 * sweeps see the chain in natural order.
 */
export async function approveChainSet(
  proposalRepo: ProposalRepository,
  tenantId: string,
  headId: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
  channel?: ApprovalChannel,
  hasPendingEdit?: PendingEditChecker,
): Promise<ApproveChainSetResult> {
  const head = await proposalRepo.findById(tenantId, headId);
  if (!head) throw new NotFoundError('Proposal', headId);

  const headMeta = chainMetaFor(head);
  if (!headMeta || headMeta.chainIndex !== 0) {
    const approved = await approveProposal(
      proposalRepo,
      tenantId,
      headId,
      actorId,
      actorRole,
      auditRepo,
      channel,
    );
    return { approved: [approved], skipped: [] };
  }

  const approvedHead = await approveProposal(
    proposalRepo,
    tenantId,
    headId,
    actorId,
    actorRole,
    auditRepo,
    channel,
  );
  const approved: Proposal[] = [approvedHead];
  const skipped: ApproveChainSetResult['skipped'] = [];

  const siblings = await proposalRepo.findByChain(tenantId, headMeta.chainId);
  if (!siblings.some((p) => p.id === headId)) {
    if (auditRepo) {
      await auditRepo.create(
        createAuditEvent({
          tenantId,
          actorId,
          actorRole,
          eventType: 'proposal.chain_set_warning',
          entityType: 'proposal',
          entityId: headId,
          metadata: {
            reason: 'head_missing_from_chain_lookup',
            chainId: headMeta.chainId,
          },
        }),
      );
    }
    return { approved, skipped };
  }

  const ordered = siblings.sort((a, b) => {
    const ai = chainMetaFor(a)?.chainIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = chainMetaFor(b)?.chainIndex ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  for (const proposal of ordered) {
    if (proposal.id === headId) continue;

    if (actionClassForProposalType(proposal.proposalType) !== 'capture') {
      skipped.push({ id: proposal.id, reason: 'non_capture' });
      continue;
    }
    if (!isReviewableForChainSet(proposal)) {
      skipped.push({ id: proposal.id, reason: 'not_reviewable' });
      continue;
    }
    if (confidenceMetaBlocksAutoApprove(proposal.payload)) {
      skipped.push({ id: proposal.id, reason: 'low_confidence' });
      continue;
    }
    if (hasPendingEdit && (await hasPendingEdit(tenantId, proposal.id))) {
      skipped.push({ id: proposal.id, reason: 'pending_edit' });
      continue;
    }
    if (missingFieldsFor(proposal).length > 0) {
      skipped.push({ id: proposal.id, reason: 'missing_fields' });
      continue;
    }

    try {
      const updated = await approveProposal(
        proposalRepo,
        tenantId,
        proposal.id,
        actorId,
        actorRole,
        auditRepo,
        channel,
      );
      approved.push(updated);
    } catch (err) {
      skipped.push({ id: proposal.id, reason: 'error' });
      if (auditRepo) {
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId,
            actorRole,
            eventType: 'proposal.chain_set_member_skipped',
            entityType: 'proposal',
            entityId: proposal.id,
            metadata: {
              reason: 'error',
              headId,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        );
      }
    }
  }

  return { approved, skipped };
}

/**
 * Decision 9 — 5-second undo window.
 *
 * Reverse an approval that was made in the last UNDO_WINDOW_MS.
 * Transitions an approved proposal to 'undone' (terminal). After the
 * window passes, undo fails — the only way to "undo" then is to
 * reverse the underlying entity via a new proposal.
 */
export async function undoProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
  correctionLoop?: UndoCorrectionLoopDeps,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    // Same permission as approve — if you can approve you can undo.
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'approved') {
    throw new ValidationError(
      `Cannot undo proposal in '${proposal.status}' status — only 'approved' proposals can be undone`
    );
  }

  if (!isInUndoWindow(proposal)) {
    throw new AppError(
      'UNDO_WINDOW_CLOSED',
      `Undo window has closed (${UNDO_WINDOW_MS}ms). To reverse the action, create a new proposal.`,
      409
    );
  }

  const transitioned = transitionProposal(proposal, 'undone', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'undone', {
    undoneAt: transitioned.undoneAt,
    undoneBy: transitioned.undoneBy,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the undo so the timeline preserves the
  // approve→undo sequence (distinct event from rejected).
  if (auditRepo) {
    await logProposalEvent(auditRepo, updated, 'proposal.undone', {
      id: actorId,
      role: actorRole,
    });
  }

  // N-009 / P2-038 — reverse any structured correction lessons this proposal
  // recorded (and the config each cascaded). Linked via source_proposal_id, so
  // no proposal-payload change is needed. Failure-soft: each undo is idempotent
  // and a throw here is logged + swallowed — it must never break the undo path.
  if (correctionLoop && auditRepo) {
    try {
      const lessons = await correctionLoop.lessonRepo.findBySourceProposal(tenantId, proposalId);
      for (const lesson of lessons) {
        // Per-lesson failure-soft: one lesson's reversal throwing must not
        // abort the remaining reversals (a single outer try would skip them).
        try {
          await undoCorrectionLesson(
            { tenantId, lessonId: lesson.id, ownerId: actorId },
            { repository: correctionLoop.lessonRepo, ports: correctionLoop.ports, auditRepo },
          );
        } catch (err) {
          logger.error('undoProposal: individual undoCorrectionLesson reversal failed', {
            proposalId,
            lessonId: lesson.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('undoProposal: findBySourceProposal failed', {
        proposalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return updated;
}

export async function rejectProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  reason: string,
  details?: string,
  appointmentRepo?: AppointmentRepository,
  auditRepo?: AuditRepository,
  channel?: ApprovalChannel,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const transitioned = transitionProposal(proposal, 'rejected', actorId);

  const updated = await proposalRepo.updateStatus(tenantId, proposalId, 'rejected', {
    rejectionReason: reason,
    rejectionDetails: details,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the rejection. Built inline (vs. logProposalEvent)
  // so the rejection reason + details ride on metadata; the helper only
  // carries the proposalType + status by default.
  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.rejected',
        entityType: 'proposal',
        entityId: updated.id,
        metadata: {
          proposalType: updated.proposalType,
          status: updated.status,
          rejectionReason: reason,
          rejectionDetails: details,
          // RV-073 — transport the rejection arrived on. Omitted when the
          // call site has not declared one (legacy behavior).
          ...(channel ? { channel } : {}),
        },
      }),
    );
  }

  // Releasing the held slot: a rejected create_booking proposal means
  // the owner declined the AI's tentative hold — cancel the held
  // appointment so the calendar slot frees up. Best-effort: a missing
  // appointmentRepo or a non-string appointmentId is simply skipped.
  if (
    appointmentRepo &&
    updated.proposalType === 'create_booking' &&
    typeof updated.payload.appointmentId === 'string'
  ) {
    const released = await updateAppointment(
      tenantId,
      updated.payload.appointmentId,
      { status: 'canceled', holdPendingApproval: false },
      appointmentRepo,
    );
    if (!released) {
      // The held appointment could not be found — the proposal is still
      // rejected, and the hold will auto-release at expiry (Task 3's
      // read-time release). Surface it so a stuck-looking calendar slot
      // after a rejection is diagnosable.
      logger.warn(
        `Held appointment ${updated.payload.appointmentId} not found when releasing hold for rejected proposal ${proposalId}; it will auto-release at expiry.`
      );
    }
  }

  return updated;
}

export async function editProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  edits: Record<string, unknown>,
  auditRepo?: AuditRepository,
  // Story 3.9 — when supplied, every changed field is logged to the corrections
  // table (intent + field + before/after) as the training signal for prompt/
  // routing improvement. Capture is failure-soft (see below).
  correctionRepo?: CorrectionRepository,
  catalogRepo?: CatalogItemRepository,
): Promise<{ proposal: Proposal; editedFields: string[] }> {
  if (!hasPermission(actorRole, 'proposals:edit')) {
    throw new ForbiddenError();
  }

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') {
    throw new ValidationError(`Cannot edit proposal in '${proposal.status}' status`);
  }

  const updatedPayload = { ...proposal.payload, ...edits };

  const validation = validateProposalPayload(proposal.proposalType, updatedPayload);
  if (!validation.valid) {
    throw new ValidationError('Invalid payload after edit', { errors: validation.errors });
  }

  const recomputed = await recomputePricedProposalOnEdit(catalogRepo, {
    tenantId,
    proposalType: proposal.proposalType,
    payload: updatedPayload,
    confidenceScore: proposal.confidenceScore,
    confidenceFactors: proposal.confidenceFactors,
  });

  const editedFields = Object.keys(edits).filter(
    (key) => JSON.stringify(proposal.payload[key]) !== JSON.stringify(edits[key])
  );

  const updated = await proposalRepo.update(tenantId, proposalId, {
    payload: recomputed.payload,
    confidenceScore: recomputed.confidenceScore,
    confidenceFactors: recomputed.confidenceFactors,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // D2-1c — audit-log the edit. Custom event (vs. logProposalEvent) so
  // editedFields rides on metadata; the inbox + history UI surfaces
  // which keys changed.
  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.edited',
        entityType: 'proposal',
        entityId: updated.id,
        metadata: {
          proposalType: updated.proposalType,
          status: updated.status,
          editedFields,
        },
      }),
    );
  }

  // Story 3.9 — capture each changed field as a correction row keyed by intent
  // (the proposal type). Failure-soft: the payload is already written, so a
  // capture failure is logged and swallowed rather than 500-ing the edit after
  // a successful write (corrections are an analytics signal, not user state).
  if (correctionRepo && editedFields.length > 0) {
    try {
      const corrections = computeCorrections({
        tenantId,
        proposalId: updated.id,
        intent: updated.proposalType,
        actorId,
        fields: editedFields,
        before: proposal.payload,
        after: recomputed.payload,
      });
      if (corrections.length > 0) {
        await correctionRepo.recordMany(corrections);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('editProposal: correction capture failed', {
        proposalId: updated.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { proposal: updated, editedFields };
}

/**
 * §5.5 Re-propose an expired schedule proposal. Expired is terminal, so the
 * operator doesn't revive the old card — they mint a fresh draft carrying the
 * same intent (proposalType + payload + summary + target), which gets a new
 * 48h expiry from `createProposal`'s schedule default and re-enters the inbox
 * for approval. Tenant-scoped; the source must be an expired schedule proposal;
 * audited as `proposal.reproposed` against the new proposal.
 */
export async function reproposeProposal(
  proposalRepo: ProposalRepository,
  tenantId: string,
  id: string,
  actorId: string,
  actorRole: Role,
  auditRepo?: AuditRepository,
): Promise<Proposal> {
  const source = await proposalRepo.findById(tenantId, id);
  if (!source) throw new NotFoundError('Proposal', id);
  if (source.status !== 'expired') {
    throw new ConflictError(
      `Only an expired proposal can be re-proposed (current status: '${source.status}')`,
    );
  }
  if (!isExpirableProposalType(source.proposalType)) {
    throw new ValidationError('Only expirable proposals can be re-proposed');
  }

  const replacement = createProposal({
    tenantId,
    proposalType: source.proposalType,
    // Deep-clone so the new draft's payload doesn't alias the expired source's
    // (a later edit to one must not mutate the other). Payloads are JSON values
    // — the same shape that round-trips through the JSONB column — so a
    // structured clone is faithful.
    payload: structuredClone(source.payload),
    summary: source.summary,
    explanation: source.explanation,
    targetEntityType: source.targetEntityType,
    targetEntityId: source.targetEntityId,
    createdBy: actorId,
    // Carry the source's unfilled required fields forward so a re-proposed
    // draft that was incomplete stays gated — approveProposal refuses a draft
    // with outstanding missingFields, and dropping them here would let the
    // clone be approved with the same incomplete payload.
    missingFields: missingFieldsFor(source),
    // A fresh 48h expiry is applied by createProposal's schedule-type default.
    // chainId is intentionally NOT carried: a re-proposal is a standalone card
    // (the original chain's siblings have also expired), so it must not link
    // back into a dead chain.
  });
  const created = await proposalRepo.create(replacement);

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.reproposed',
        entityType: 'proposal',
        entityId: created.id,
        metadata: { sourceProposalId: source.id, proposalType: source.proposalType },
      }),
    );
  }
  return created;
}
