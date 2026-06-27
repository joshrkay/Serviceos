/**
 * U8 (E9) — resolve an ambiguous entity reference on a voice_clarification.
 *
 * When the entity resolver matches a free-text reference ("Bob") to several
 * tenant records it emits a `voice_clarification` carrying the candidate list
 * (`payload.entityCandidates`) and the original request context
 * (`sourceContext.entityKind` / `entityReference` / `transcript`). Picking a
 * candidate used to `reject('entity_selected', id)` — which DISCARDED the
 * original intent (the audit's E9 dead-end: "which Bob?" lost the command).
 *
 * This service is the owner's one-tap resolution: it re-drafts the original
 * action by resolving the reference to the chosen entity id, stamps that id
 * onto the payload (under the field its entity kind fills, e.g. customer →
 * `customerId`) and onto `targetEntityId`, clears the entity clarification from
 * sourceContext, and surfaces the proposal for review.
 *
 * Invariants:
 *  - The chosen `candidateId` MUST be one of the proposal's surfaced
 *    candidates — never an arbitrary id (rejected 400).
 *  - No auto-execute (D-004): resolution caps at `ready_for_review`; it never
 *    approves or executes. The re-drafted action still needs a deliberate tap.
 *  - Audited: every resolution emits `proposal.entity_resolved`.
 *  - Tenant-scoped: every read/write goes through the tenant-scoped repo.
 */
import { Role, hasPermission } from '../auth/rbac';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors';
import { Proposal, ProposalRepository } from './proposal';

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
