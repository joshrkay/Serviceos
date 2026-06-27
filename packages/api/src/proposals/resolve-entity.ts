/**
 * U8 (E9) — resolve an ambiguous entity reference on a voice_clarification.
 *
 * When the entity resolver matches a free-text reference ("Bob") to several
 * tenant records it emits a `voice_clarification` carrying the candidate list
 * (`payload.entityCandidates`) and the original request context
 * (`sourceContext.entityKind` / `entityReference` / `transcript` /
 * `originalIntent`). Picking a candidate used to `reject('entity_selected', id)`
 * — which DISCARDED the original intent (the audit's E9 dead-end: "which Bob?"
 * lost the command).
 *
 * U1 (E9 re-draft): this service is the owner's one-tap resolution. It re-runs
 * the ORIGINAL task handler (recovered from `sourceContext.originalIntent`) with
 * the chosen entity id injected — exactly the catalog-grounded drafting path the
 * non-ambiguous voice route uses — and REPLACES the `voice_clarification` with
 * the freshly drafted, EXECUTABLE typed proposal (e.g. draft_invoice). The
 * voice_clarification type has no execution handler, so leaving it in place made
 * approval a silent no-op (HANDLER_NOT_FOUND at execute time); transitioning the
 * type fixes that while keeping the human in the loop.
 *
 * Invariants:
 *  - The chosen `candidateId` MUST be one of the proposal's surfaced
 *    candidates — never an arbitrary id (rejected 400).
 *  - Catalog grounding: the re-draft goes through the grounded TaskHandler
 *    (applyCatalogPricing), never a hand-rolled payload.
 *  - No auto-execute (D-004): resolution caps at `ready_for_review`; it never
 *    approves or executes. The re-drafted action still needs a deliberate tap.
 *  - Zod-valid: the re-drafted payload is validated for its NEW type before
 *    persisting (assertValidProposalPayload).
 *  - Audited: every resolution emits `proposal.entity_resolved` (and records the
 *    type transition).
 *  - Tenant-scoped: every read/write goes through the tenant-scoped repo.
 */
import { Role, hasPermission } from '../auth/rbac';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors';
import { Proposal, ProposalRepository } from './proposal';
import { assertValidProposalPayload } from './contracts';
import type { IntentType } from '../ai/orchestration/intent-classifier';
import type { TaskContext } from '../ai/tasks/task-handlers';
import type { RedraftHandlerFactory } from './redraft-handler-factory';

interface EntityCandidate {
  id: string;
  label?: string;
  hint?: string;
  kind?: string;
  score?: number;
}

export interface ResolveEntityInput {
  tenantId: string;
  proposalId: string;
  candidateId: string;
  actorId: string;
  actorRole: Role;
}

export interface ResolveEntityDeps {
  proposalRepo: ProposalRepository;
  auditRepo?: AuditRepository;
  /**
   * U1 (E9) — re-draft handler factory. When supplied AND the clarification
   * persisted an `originalIntent` (the producer in voice-action-router does
   * this on the entity-ambiguity path), resolution re-runs the original task
   * handler with the resolved id and REPLACES the voice_clarification with the
   * drafted, executable proposal. Optional so legacy/back-compat callers (and
   * unit tests of the bare grounding gate) keep the annotate-only behavior.
   */
  redraftHandlerFactory?: RedraftHandlerFactory;
}

/** The structured original-intent context the producer stamps for re-draft. */
interface OriginalIntent {
  intentType: IntentType;
  extractedEntities: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * The payload field a resolved entity of `kind` fills. The re-drafted action
 * carries the verified id here (mirrors the voice path's
 * `annotation.resolved.customerId` / `jobId` stamping). Unknown/absent kinds
 * fall back to a generic `resolvedEntityId` so the choice is never silently
 * dropped.
 */
function payloadFieldForKind(kind: string | undefined): string {
  switch (kind) {
    case 'customer':
      return 'customerId';
    case 'job':
      return 'jobId';
    case 'appointment':
      return 'appointmentId';
    case 'invoice':
      return 'invoiceId';
    case 'estimate':
      return 'estimateId';
    default:
      return 'resolvedEntityId';
  }
}

/** Read the candidate set from payload (where the emitter writes it) or, as a
 *  fallback, sourceContext. */
function readCandidates(
  payload: Record<string, unknown>,
  sourceContext: Record<string, unknown>,
): EntityCandidate[] {
  const fromPayload = payload.entityCandidates;
  const fromContext = sourceContext.entityCandidates;
  const raw = Array.isArray(fromPayload)
    ? fromPayload
    : Array.isArray(fromContext)
      ? fromContext
      : [];
  return raw
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map((c) => ({
      id: typeof c.id === 'string' ? c.id : '',
      label: typeof c.label === 'string' ? c.label : undefined,
      hint: typeof c.hint === 'string' ? c.hint : undefined,
      kind: typeof c.kind === 'string' ? c.kind : undefined,
      score: typeof c.score === 'number' ? c.score : undefined,
    }))
    .filter((c) => c.id.length > 0);
}

/**
 * Read the persisted original-intent context (U1). Returns undefined when the
 * clarification predates the producer change (back-compat) or carries a
 * malformed shape — resolution then falls back to the annotate-only path.
 */
function readOriginalIntent(sourceContext: Record<string, unknown>): OriginalIntent | undefined {
  const raw = sourceContext.originalIntent;
  if (raw === null || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.intentType !== 'string') return undefined;
  return {
    intentType: obj.intentType as IntentType,
    extractedEntities: asRecord(obj.extractedEntities),
  };
}

export async function resolveProposalEntity(
  input: ResolveEntityInput,
  deps: ResolveEntityDeps,
): Promise<Proposal> {
  const { tenantId, proposalId, candidateId, actorId, actorRole } = input;

  // Same authority as approving — resolving the reference patches a draft the
  // owner will then approve.
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }
  if (typeof candidateId !== 'string' || candidateId.length === 0) {
    throw new ValidationError('candidateId is required');
  }

  const proposal = await deps.proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }
  // Only a proposal still under review can be patched — never one already
  // approved/executed/rejected (terminal states can't be re-drafted).
  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') {
    throw new ValidationError(
      `Cannot resolve an entity on a proposal in '${proposal.status}' status`,
    );
  }

  const payload = asRecord(proposal.payload);
  const sourceContext = asRecord(proposal.sourceContext);

  const candidates = readCandidates(payload, sourceContext);
  if (candidates.length === 0) {
    throw new ValidationError('Proposal is not awaiting an entity choice');
  }

  // Grounding invariant: the choice must be one of the surfaced candidates —
  // never an arbitrary off-list id.
  const chosen = candidates.find((c) => c.id === candidateId);
  if (!chosen) {
    throw new ValidationError('candidateId is not among this proposal’s candidates');
  }

  // The entity kind tells us which field the resolved id fills. Prefer the
  // chosen candidate's own kind, then the proposal-level entityKind, default
  // generic.
  const entityKind =
    chosen.kind ??
    (typeof sourceContext.entityKind === 'string' ? sourceContext.entityKind : undefined);
  const field = payloadFieldForKind(entityKind);

  // U1 (E9) — re-draft path: when the producer persisted the original intent
  // AND a handler factory is wired, re-run the ORIGINAL task handler with the
  // resolved id injected and REPLACE the voice_clarification with the drafted,
  // executable typed proposal. This is the only path that makes approval do the
  // work; absent either input we fall back to the annotate-only behavior.
  const originalIntent = readOriginalIntent(sourceContext);
  const redraftHandler =
    originalIntent && deps.redraftHandlerFactory
      ? deps.redraftHandlerFactory(originalIntent.intentType)
      : undefined;

  if (originalIntent && redraftHandler) {
    return redraftResolvedProposal({
      tenantId,
      proposalId,
      actorId,
      actorRole,
      proposal,
      sourceContext,
      chosen,
      entityKind,
      field,
      candidateId,
      originalIntent,
      handler: redraftHandler,
      deps,
    });
  }

  // ── Annotate-only fallback (no originalIntent / no factory) ───────────────
  // Re-draft: resolve the reference to the chosen id. We stamp it onto the
  // payload (the field its kind fills) so the executor reads a verified id
  // instead of the free text it choked on, and onto targetEntityId for the
  // detail/deep-link surfaces.
  const nextPayload: Record<string, unknown> = {
    ...payload,
    [field]: chosen.id,
  };
  // The clarification is resolved — drop the candidate list and the
  // ambiguity markers so the card no longer renders a picker.
  delete nextPayload.entityCandidates;
  delete nextPayload.entityReference;

  const nextSourceContext: Record<string, unknown> = { ...sourceContext };
  delete nextSourceContext.entityCandidates;
  delete nextSourceContext.entityReference;
  delete nextSourceContext.entityKind;
  delete nextSourceContext.originalIntent;
  // Record the resolution so the re-drafted action (and any later audit) can
  // trace which reference was resolved to which id.
  nextSourceContext.resolvedEntity = {
    id: chosen.id,
    ...(entityKind ? { kind: entityKind } : {}),
    ...(chosen.label ? { label: chosen.label } : {}),
  };

  await deps.proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    sourceContext: nextSourceContext,
    targetEntityId: chosen.id,
    ...(entityKind ? { targetEntityType: entityKind } : {}),
  });

  // Surface for approval — but NEVER approve/execute it (D-004). Only a draft
  // is promoted; a proposal already in ready_for_review stays there.
  let movedToReview = false;
  if (proposal.status === 'draft') {
    await deps.proposalRepo.updateStatus(tenantId, proposalId, 'ready_for_review', {});
    movedToReview = true;
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.entity_resolved',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          candidateId,
          ...(entityKind ? { entityKind } : {}),
          field,
          movedToReview,
        },
      }),
    );
  }

  // Re-read so the response reflects the payload patch AND any status
  // transition.
  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? proposal;
}

/**
 * U1 (E9) — re-draft the original action with the resolved id and replace the
 * voice_clarification with the executable typed proposal.
 */
async function redraftResolvedProposal(args: {
  tenantId: string;
  proposalId: string;
  actorId: string;
  actorRole: Role;
  proposal: Proposal;
  sourceContext: Record<string, unknown>;
  chosen: EntityCandidate;
  entityKind: string | undefined;
  field: string;
  candidateId: string;
  originalIntent: OriginalIntent;
  handler: import('../ai/tasks/task-handlers').TaskHandler;
  deps: ResolveEntityDeps;
}): Promise<Proposal> {
  const {
    tenantId,
    proposalId,
    actorId,
    actorRole,
    proposal,
    sourceContext,
    chosen,
    entityKind,
    field,
    candidateId,
    originalIntent,
    handler,
    deps,
  } = args;

  // Reconstruct the resolved id into existingEntities EXACTLY as the voice
  // router does on the non-ambiguous path: the original extracted entities,
  // plus the verified id stamped under the field its kind fills.
  const existingEntities: Record<string, unknown> = {
    ...originalIntent.extractedEntities,
    [field]: chosen.id,
  };
  // The ambiguous free-text reference is now resolved — don't carry it forward
  // as a competing name on the same kind.
  if (entityKind === 'customer') delete existingEntities.customerName;
  if (entityKind === 'job') delete existingEntities.jobReference;

  // Stored transcript is the original message — re-draft against it, not the
  // clarification summary.
  const storedTranscript =
    typeof sourceContext.transcript === 'string' ? sourceContext.transcript : proposal.summary;
  const conversationId =
    typeof sourceContext.conversationId === 'string' ? sourceContext.conversationId : undefined;

  const context: TaskContext = {
    tenantId,
    userId: proposal.createdBy,
    message: storedTranscript,
    ...(conversationId ? { conversationId } : {}),
    existingEntities,
    // A verified customer id flows onto the context too (some handlers read
    // context.customerId), mirroring the non-ambiguous path.
    ...(entityKind === 'customer' ? { customerId: chosen.id } : {}),
  };

  const { proposal: drafted } = await handler.handle(context);

  // Zod-validate the re-drafted payload for its NEW type BEFORE persisting —
  // the type transition must satisfy the contract for the drafted type.
  assertValidProposalPayload(drafted.proposalType, drafted.payload);

  // Build the next sourceContext: keep the re-draft trace + chain edges, drop
  // the now-resolved ambiguity markers.
  const nextSourceContext: Record<string, unknown> = { ...sourceContext };
  delete nextSourceContext.entityCandidates;
  delete nextSourceContext.entityReference;
  delete nextSourceContext.entityKind;
  delete nextSourceContext.originalIntent;
  nextSourceContext.resolvedEntity = {
    id: chosen.id,
    ...(entityKind ? { kind: entityKind } : {}),
    ...(chosen.label ? { label: chosen.label } : {}),
  };
  // Merge any sourceContext the drafting handler produced (e.g. missingFields),
  // but keep the clarification's conversation/recording trace which the
  // handler doesn't know about.
  const draftedCtx = asRecord(drafted.sourceContext);
  for (const [k, v] of Object.entries(draftedCtx)) {
    if (k === 'conversationId') continue; // already carried above
    nextSourceContext[k] = v;
  }

  // D-004: NEVER approve/execute during resolution. The drafted handler may
  // have computed an auto-approve status; resolution unconditionally caps the
  // transitioned proposal at 'ready_for_review' (a draft re-draft is promoted
  // for review, never further). This is the resolution-time analogue of
  // holdIfUnsupervised — but stronger: it ignores the handler's status entirely
  // so a re-draft can never slip past the human gate.
  await deps.proposalRepo.update(tenantId, proposalId, {
    proposalType: drafted.proposalType,
    payload: drafted.payload,
    summary: drafted.summary,
    ...(drafted.explanation !== undefined ? { explanation: drafted.explanation } : {}),
    ...(drafted.confidenceScore !== undefined ? { confidenceScore: drafted.confidenceScore } : {}),
    sourceContext: nextSourceContext,
    targetEntityId: chosen.id,
    ...(entityKind ? { targetEntityType: entityKind } : {}),
    // chainId is preserved implicitly — `update` only patches the listed fields,
    // so a clarification that was a chain member keeps its chainId column and
    // its sourceContext.chainId/chainIndex edges (copied above) untouched.
  });
  await deps.proposalRepo.updateStatus(tenantId, proposalId, 'ready_for_review', {});

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.entity_resolved',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          candidateId,
          ...(entityKind ? { entityKind } : {}),
          field,
          // Record the type transition so the audit trail shows the
          // clarification became an executable action.
          fromProposalType: proposal.proposalType,
          toProposalType: drafted.proposalType,
          intentType: originalIntent.intentType,
          movedToReview: true,
        },
      }),
    );
  }

  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? proposal;
}
