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
 *  - Mirrors the canonical voice path (voice-action-router): the re-draft runs
 *    the SAME grounded TaskHandler, maps entities with `entitiesForProposal`,
 *    and tracks an incomplete-but-typed draft via `sourceContext.missingFields`
 *    (NOT a hard per-type Zod throw). A customer-name ambiguity drafting a
 *    draft_invoice has no jobId and CreateJobVoiceTaskHandler never stamps
 *    customerId — those are required-but-missing fields, so the canonical path
 *    persists the draft and lets the approval gate (missingFieldsFor) block it.
 *    A hard validation throw here would 400 exactly those common cases.
 *  - Audited: every resolution emits `proposal.entity_resolved` (and records the
 *    type transition).
 *  - Tenant-scoped: every read/write goes through the tenant-scoped repo.
 *
 * P8/U-multi (multi-ambiguity chain): a single utterance can carry MORE than
 * one ambiguous reference ("invoice Bob for the Rodriguez job" where both
 * "Bob" and "Rodriguez job" match several records). The producer
 * (voice-action-router's emitClarification) can only surface one candidate
 * list per voice_clarification, so it persists the rest on
 * `sourceContext.pendingEntityAmbiguities` and warns the operator more picks
 * are coming. Consuming that queue lives HERE: after applying a pick, if
 * `pendingEntityAmbiguities` is still non-empty, resolution does NOT redraft
 * — it pops the next queued ambiguity and turns THIS SAME proposal row back
 * into a fresh voice_clarification for it (mirroring emitClarification's
 * payload/summary/explanation/sourceContext shape), carrying every
 * already-resolved entity forward on `sourceContext.resolvedEntities` so the
 * eventual redraft (once the queue drains) has all of them, not just the
 * last one. Reusing the same proposal id — rather than creating a new
 * proposal per queued ambiguity — is also what makes a retried/double-tapped
 * pick safe: see the `alreadyResolved` check in `resolveProposalEntity`.
 */
import { Role, hasPermission } from '../auth/rbac';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors';
import { Proposal, ProposalRepository, missingFieldsFor } from './proposal';
import { assertValidProposalPayload, validateProposalPayload } from './contracts';
import type { IntentType } from '../ai/orchestration/intent-classifier';
import type { TaskContext } from '../ai/tasks/task-handlers';
import { entitiesForProposal } from '../workers/voice-action-router';
import type { RedraftHandlerFactory } from './redraft-handler-factory';
import { clearSatisfiedMissingFields } from './missing-fields';
import type { EntityAliasCandidateCapture } from '../learning/entity-aliases/candidate-service';

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
  /**
   * Tenant learning loop — after a grounded picker selection, emit a deduped
   * adopt_entity_alias review proposal. Failure-soft: resolution still succeeds
   * if capture throws.
   */
  entityAliasCandidateCapture?: EntityAliasCandidateCapture;
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
 * Derive the top-level required fields the drafted payload is still missing for
 * its NEW type, WITHOUT throwing. Mirrors the canonical voice path: an
 * incomplete-but-typed draft (e.g. a draft_invoice with no jobId because the
 * ambiguity was a customer name) is persisted and gated via
 * `sourceContext.missingFields`, not rejected with a 400. We read the validator
 * (non-throwing) and map each error's top-level path segment to a missing
 * field; the approval gate (missingFieldsFor → approveProposal) then blocks
 * execution until the operator fills it. Errors with no field path (whole-object
 * refinements) are ignored here — they don't name a single fillable field.
 */
function missingRequiredFieldsForDraft(
  proposalType: string,
  payload: unknown,
): string[] {
  const result = validateProposalPayload(proposalType, payload);
  if (result.valid || !result.errors) return [];
  const fields = new Set<string>();
  for (const err of result.errors) {
    const field = err.split(':', 1)[0].trim();
    // Top-level fields only (e.g. `jobId`); skip nested paths
    // (`lineItems.0.unitPriceCents`) and pathless refinements.
    if (field.length > 0 && !field.includes('.')) {
      fields.add(field);
    }
  }
  return [...fields];
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

/** Defensively parse a raw candidate array (payload/sourceContext copy, or a
 *  queued ambiguity's candidate list) into the local, relaxed shape. Shared by
 *  `readCandidates` and `readPendingAmbiguities` so both tolerate the same
 *  malformed/legacy shapes. */
function parseCandidateList(raw: unknown): EntityCandidate[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
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

/** Read the candidate set from payload (where the emitter writes it) or, as a
 *  fallback, sourceContext. */
function readCandidates(
  payload: Record<string, unknown>,
  sourceContext: Record<string, unknown>,
): EntityCandidate[] {
  const fromPayload = Array.isArray(payload.entityCandidates) ? payload.entityCandidates : undefined;
  return parseCandidateList(fromPayload ?? sourceContext.entityCandidates);
}

/** One already-resolved entity along a multi-ambiguity resolution chain,
 *  accumulated on `sourceContext.resolvedEntities` across pops. `field` is
 *  the payload field this entity's id fills (see `payloadFieldForKind`) —
 *  persisting it means the eventual redraft doesn't have to re-derive it. */
interface ResolvedEntityRecord {
  id: string;
  field: string;
  kind?: string;
  label?: string;
}

function readResolvedEntities(sourceContext: Record<string, unknown>): ResolvedEntityRecord[] {
  const raw = sourceContext.resolvedEntities;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' ? r.id : '',
      field: typeof r.field === 'string' ? r.field : '',
      kind: typeof r.kind === 'string' ? r.kind : undefined,
      label: typeof r.label === 'string' ? r.label : undefined,
    }))
    .filter((r) => r.id.length > 0 && r.field.length > 0);
}

/** A queued ambiguous reference from the SAME utterance, not yet surfaced —
 *  mirrors voice-action-router's `SingleEntityAmbiguity`, read back off
 *  `sourceContext.pendingEntityAmbiguities` (see emitClarification). */
interface PendingEntityAmbiguity {
  entityKind: string;
  reference: string;
  candidates: EntityCandidate[];
}

function readPendingAmbiguities(sourceContext: Record<string, unknown>): PendingEntityAmbiguity[] {
  const raw = sourceContext.pendingEntityAmbiguities;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
    .map((a) => ({
      entityKind: typeof a.entityKind === 'string' ? a.entityKind : '',
      reference: typeof a.reference === 'string' ? a.reference : '',
      candidates: parseCandidateList(a.candidates),
    }))
    .filter((a) => a.entityKind.length > 0 && a.candidates.length > 0);
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

async function captureEntityPickerAlias(
  deps: ResolveEntityDeps,
  input: {
    tenantId: string;
    actorId: string;
    actorRole: Role;
    groundingProposal: Proposal;
    selectedEntityId: string;
  },
): Promise<void> {
  if (!deps.entityAliasCandidateCapture) return;
  try {
    await deps.entityAliasCandidateCapture.capture({
      source: 'entity_picker',
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorRole: input.actorRole,
      groundingProposal: input.groundingProposal,
      selectedEntityId: input.selectedEntityId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('resolveProposalEntity: alias candidate capture failed', {
      proposalId: input.groundingProposal.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
    // B2 — a single-shot annotate-only resolution (no pending ambiguities,
    // e.g. a gated send_invoice) clears entityCandidates entirely once
    // resolved, so a retried/double-tapped request finds no live candidate
    // set here at all (unlike the multi-ambiguity chain, where the NEXT
    // ambiguity's candidates keep this list non-empty). Mirror the
    // alreadyResolved idempotency check below: if this exact candidateId was
    // already resolved earlier in this proposal's history, the retry is a
    // successful no-op, not an error.
    if (readResolvedEntities(sourceContext).some((r) => r.id === candidateId)) {
      return proposal;
    }
    throw new ValidationError('Proposal is not awaiting an entity choice');
  }

  // Grounding invariant: the choice must be one of the surfaced candidates —
  // never an arbitrary off-list id.
  const chosen = candidates.find((c) => c.id === candidateId);
  if (!chosen) {
    // Idempotency (mirrors the router's createDeduped: a redelivered/
    // double-tapped request is a successful no-op, not an error). Resolution
    // mutates a SINGLE proposal row across the whole multi-ambiguity chain
    // (see the pending-ambiguity branch below) rather than creating a new
    // row per pick — so once a pick has been applied, its candidateId no
    // longer appears in the CURRENT candidate set (the row has moved on to
    // the next ambiguity, or been redrafted away entirely). If the id
    // matches an entity we already resolved earlier in this chain, this is
    // that same pick arriving twice: return the current state untouched
    // instead of 400ing a request that already succeeded once.
    const alreadyResolved = readResolvedEntities(sourceContext).some((r) => r.id === candidateId);
    if (alreadyResolved) {
      return proposal;
    }
    throw new ValidationError('candidateId is not among this proposal’s candidates');
  }

  // The entity kind tells us which field the resolved id fills. Prefer the
  // chosen candidate's own kind, then the proposal-level entityKind, default
  // generic.
  const entityKind =
    chosen.kind ??
    (typeof sourceContext.entityKind === 'string' ? sourceContext.entityKind : undefined);
  const field = payloadFieldForKind(entityKind);

  // Accumulate this pick. The eventual redraft (once the pending-ambiguity
  // queue drains, see below) needs EVERY resolved entity from this chain,
  // not just the last one.
  const resolvedEntities: ResolvedEntityRecord[] = [
    ...readResolvedEntities(sourceContext),
    {
      id: chosen.id,
      field,
      ...(entityKind ? { kind: entityKind } : {}),
      ...(chosen.label ? { label: chosen.label } : {}),
    },
  ];

  // P8/U-multi — more ambiguous references from the SAME utterance are
  // queued behind this one (producer: emitClarification's
  // additionalAmbiguities → sourceContext.pendingEntityAmbiguities). Core
  // Pattern: ambiguity on a voice path is always a clarification, never a
  // guess — so as long as ANY reference is still unresolved, advance to the
  // next picker instead of redrafting/annotating with the others left as
  // free text (or silently dropped).
  const pending = readPendingAmbiguities(sourceContext);
  if (pending.length > 0) {
    const [next, ...rest] = pending;
    await captureEntityPickerAlias(deps, {
      tenantId,
      actorId,
      actorRole,
      groundingProposal: proposal,
      selectedEntityId: candidateId,
    });
    return advanceToNextAmbiguity({
      tenantId,
      proposalId,
      actorId,
      actorRole,
      proposal,
      payload,
      sourceContext,
      chosen,
      entityKind,
      field,
      candidateId,
      resolvedEntities,
      next,
      rest,
      deps,
    });
  }

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
      resolvedEntities,
      originalIntent,
      handler: redraftHandler,
      deps,
    });
  }

  // ── Annotate-only fallback (no originalIntent / no factory) ───────────────
  // Re-draft: resolve every reference gathered across this chain to its
  // chosen id. We stamp each onto the payload (the field its kind fills) so
  // the executor reads verified ids instead of the free text it choked on,
  // and the LAST one onto targetEntityId for the detail/deep-link surfaces.
  const nextPayload: Record<string, unknown> = { ...payload };
  for (const resolved of resolvedEntities) {
    nextPayload[resolved.field] = resolved.id;
  }
  // The clarification is resolved — drop the candidate list and the
  // ambiguity markers so the card no longer renders a picker.
  delete nextPayload.entityCandidates;
  delete nextPayload.entityReference;

  const nextSourceContext: Record<string, unknown> = { ...sourceContext };
  delete nextSourceContext.entityCandidates;
  delete nextSourceContext.entityReference;
  delete nextSourceContext.entityKind;
  delete nextSourceContext.originalIntent;
  delete nextSourceContext.pendingEntityAmbiguities;
  // Record every resolution (and, back-compat, the last one alone under the
  // singular key) so the re-drafted action (and any later audit) can trace
  // which reference(s) were resolved to which id(s).
  nextSourceContext.resolvedEntities = resolvedEntities;
  nextSourceContext.resolvedEntity = {
    id: chosen.id,
    ...(entityKind ? { kind: entityKind } : {}),
    ...(chosen.label ? { label: chosen.label } : {}),
  };

  // B2 — a TYPED money proposal (send_invoice / update_invoice /
  // update_estimate) reaches this annotate-only path carrying no
  // originalIntent (verified: none of those handlers stamp it), so it is
  // NEVER re-drafted here — only annotated. Such a proposal may carry a flat
  // `sourceContext.missingFields` gate (e.g. ['invoiceId']) stamped by its
  // drafting handler. This pick just resolved one entry — clear ONLY the
  // fields this pick actually satisfied (B1's clear-on-fill helper: never a
  // blanket schema recompute, see missing-fields.ts's doc comment for why
  // that would silently reopen the doomed-approval bug) and, critically,
  // promote draft→ready_for_review ONLY when nothing is left gated. A
  // voice_clarification (the common caller of this path) never carries
  // missingFields at all, so it keeps promoting unconditionally exactly as
  // before — this branch is a no-op for that case.
  const currentMissingFields = Array.isArray(sourceContext.missingFields)
    ? (sourceContext.missingFields as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined;
  let remainingMissingFields: string[] | undefined;
  if (currentMissingFields) {
    const editedKeys = resolvedEntities.map((r) => r.field);
    remainingMissingFields = clearSatisfiedMissingFields(currentMissingFields, editedKeys, nextPayload);
    if (remainingMissingFields.length > 0) {
      nextSourceContext.missingFields = remainingMissingFields;
    } else {
      delete nextSourceContext.missingFields;
    }
  }

  await deps.proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    sourceContext: nextSourceContext,
    targetEntityId: chosen.id,
    ...(entityKind ? { targetEntityType: entityKind } : {}),
  });

  // Surface for approval — but NEVER approve/execute it (D-004). Only a draft
  // is promoted, and only once nothing is left gated; a proposal already in
  // ready_for_review stays there.
  const stillGated = remainingMissingFields !== undefined && remainingMissingFields.length > 0;
  let movedToReview = false;
  if (proposal.status === 'draft' && !stillGated) {
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

  await captureEntityPickerAlias(deps, {
    tenantId,
    actorId,
    actorRole,
    groundingProposal: proposal,
    selectedEntityId: candidateId,
  });

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
  /** Every entity resolved across this chain (this pick included) — see the
   *  module doc comment (P8/U-multi). Single-ambiguity callers pass a
   *  one-element array, so this subsumes the old chosen-only behavior. */
  resolvedEntities: ResolvedEntityRecord[];
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
    resolvedEntities,
    originalIntent,
    handler,
    deps,
  } = args;

  // Reconstruct the resolved id into existingEntities EXACTLY as the voice
  // router does on the non-ambiguous path: map the original extracted entities
  // through `entitiesForProposal` (so e.g. a create_customer's displayName
  // becomes `name`, matching the Zod contract) FIRST, then stamp the verified
  // id under the field its kind fills. Passing raw extractedEntities would
  // diverge from the canonical drafting and feed handlers the wrong keys.
  const mappedEntities =
    originalIntent.intentType === 'unknown'
      ? { ...originalIntent.extractedEntities }
      : {
          ...(entitiesForProposal(
            originalIntent.intentType,
            originalIntent.extractedEntities as never,
          ) ?? {}),
        };
  // P8/U-multi — stamp EVERY resolved entity from this chain, not just the
  // one that triggered this call. A two-ambiguity utterance ("Bob" +
  // "Rodriguez job") resolves customerId on the first pick and jobId on the
  // second; by the time we get here (no pending ambiguities left) both must
  // land, or the first resolution would silently regress to free text.
  const existingEntities: Record<string, unknown> = { ...mappedEntities };
  for (const resolved of resolvedEntities) {
    existingEntities[resolved.field] = resolved.id;
  }
  // The ambiguous free-text reference is now resolved — don't carry it forward
  // as a competing name on the same kind.
  for (const resolved of resolvedEntities) {
    if (resolved.kind === 'customer') delete existingEntities.customerName;
    if (resolved.kind === 'job') delete existingEntities.jobReference;
  }

  // Stored transcript is the original message — re-draft against it, not the
  // clarification summary.
  const storedTranscript =
    typeof sourceContext.transcript === 'string' ? sourceContext.transcript : proposal.summary;
  const conversationId =
    typeof sourceContext.conversationId === 'string' ? sourceContext.conversationId : undefined;
  // A verified customer id may have been resolved on ANY pick in the chain
  // (not necessarily this one) — find it among everything resolved so far.
  const resolvedCustomerId = resolvedEntities.find((r) => r.kind === 'customer')?.id;

  const context: TaskContext = {
    tenantId,
    userId: proposal.createdBy,
    message: storedTranscript,
    ...(conversationId ? { conversationId } : {}),
    existingEntities,
    // A verified customer id flows onto the context too (some handlers read
    // context.customerId), mirroring the non-ambiguous path.
    ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
  };

  const { proposal: drafted } = await handler.handle(context);

  // Mirror the canonical voice path: do NOT hard-throw on a typed draft that is
  // merely INCOMPLETE. A customer-name ambiguity drafting a draft_invoice has no
  // jobId; CreateJobVoiceTaskHandler never stamps customerId — both are
  // required-but-missing fields the canonical path tracks via missingFields and
  // the approval gate blocks on, rather than 400-ing the resolution.
  //
  // Carry the handler's own reported missingFields (it persists them on its
  // proposal's sourceContext) AND union in any top-level required fields the
  // drafted payload is still missing for its new type, so an incomplete-but-
  // typed draft can never be approved (missingFieldsFor → approveProposal) with
  // an invalid payload. This is the resolution-time analogue of the canonical
  // drafting's missingFields gating — not a throw.
  const handlerMissing = missingFieldsFor(drafted);
  const schemaMissing = missingRequiredFieldsForDraft(drafted.proposalType, drafted.payload);
  const missingFields = [...new Set([...handlerMissing, ...schemaMissing])];

  // Build the next sourceContext: keep the re-draft trace + chain edges, drop
  // the now-resolved ambiguity markers.
  const nextSourceContext: Record<string, unknown> = { ...sourceContext };
  delete nextSourceContext.entityCandidates;
  delete nextSourceContext.entityReference;
  delete nextSourceContext.entityKind;
  delete nextSourceContext.originalIntent;
  delete nextSourceContext.pendingEntityAmbiguities;
  // Record every resolution from this chain (and, back-compat, the last one
  // alone under the singular key).
  nextSourceContext.resolvedEntities = resolvedEntities;
  nextSourceContext.resolvedEntity = {
    id: chosen.id,
    ...(entityKind ? { kind: entityKind } : {}),
    ...(chosen.label ? { label: chosen.label } : {}),
  };
  // Merge any sourceContext the drafting handler produced (e.g. catalogResolution
  // ambiguity candidates), but keep the clarification's conversation/recording
  // trace which the handler doesn't know about. missingFields is set explicitly
  // below (unioned), so skip the handler's copy here to avoid clobbering it.
  const draftedCtx = asRecord(drafted.sourceContext);
  for (const [k, v] of Object.entries(draftedCtx)) {
    if (k === 'conversationId') continue; // already carried above
    if (k === 'missingFields') continue; // unioned and set below
    nextSourceContext[k] = v;
  }
  // Carry incompleteness forward so approveProposal blocks an incomplete draft
  // (missingFieldsFor reads sourceContext.missingFields). Drop the key entirely
  // when complete so a fully-resolved draft is approvable.
  if (missingFields.length > 0) {
    nextSourceContext.missingFields = missingFields;
  } else {
    delete nextSourceContext.missingFields;
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
          // P8/U-multi trace: how many entity references this utterance's
          // chain resolved in total (1 for the common single-ambiguity case).
          resolvedCount: resolvedEntities.length,
        },
      }),
    );
  }

  await captureEntityPickerAlias(deps, {
    tenantId,
    actorId,
    actorRole,
    groundingProposal: proposal,
    selectedEntityId: candidateId,
  });

  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? proposal;
}

/**
 * P8/U-multi — advance a multi-entity-ambiguity clarification to the NEXT
 * queued ambiguity instead of redrafting/annotating.
 *
 * Mirrors emitClarification's entity-ambiguity payload/summary/explanation/
 * sourceContext shape (voice-action-router.ts) so the surfaced picker is
 * indistinguishable from one the producer emitted directly — the operator
 * sees "which job?" appear right after tapping "which customer?", exactly as
 * the first clarification's explanation promised ("N more references will
 * need picking after this").
 *
 * Deliberately mutates the SAME proposal row (rather than creating a new
 * one) instead of the producer's create-a-new-proposal pattern: this one
 * utterance already has exactly one live proposal representing "the question
 * the operator still owes an answer to", and there is never more than one
 * such question in flight at a time (the payload contract only ever holds
 * one candidate list). Reusing the row is also what makes a retried pick
 * idempotent — see the `alreadyResolved` check in `resolveProposalEntity`,
 * which this makes possible: once this runs, the prior pick's candidateId is
 * gone from the proposal's live candidate set, so a duplicate request can
 * never re-trigger it.
 */
async function advanceToNextAmbiguity(args: {
  tenantId: string;
  proposalId: string;
  actorId: string;
  actorRole: Role;
  proposal: Proposal;
  payload: Record<string, unknown>;
  sourceContext: Record<string, unknown>;
  chosen: EntityCandidate;
  entityKind: string | undefined;
  field: string;
  candidateId: string;
  resolvedEntities: ResolvedEntityRecord[];
  next: PendingEntityAmbiguity;
  rest: PendingEntityAmbiguity[];
  deps: ResolveEntityDeps;
}): Promise<Proposal> {
  const {
    tenantId,
    proposalId,
    actorId,
    actorRole,
    proposal,
    payload,
    sourceContext,
    chosen,
    entityKind,
    field,
    candidateId,
    resolvedEntities,
    next,
    rest,
    deps,
  } = args;

  // Payload contract (voiceClarificationPayloadSchema) requires label/score
  // on each candidate. Queued candidates always came from a real
  // EntityCandidate (producer-side, both required) — the fallbacks here only
  // guard against a malformed/legacy persisted shape, mirroring the
  // defensive parsing in readPendingAmbiguities.
  const nextPayloadCandidates = next.candidates.map((c) => ({
    id: c.id,
    label: c.label ?? c.id,
    ...(c.hint ? { hint: c.hint } : {}),
    score: c.score ?? 0,
  }));
  const nextPayload: Record<string, unknown> = {
    ...payload,
    entityReference: next.reference,
    entityCandidates: nextPayloadCandidates,
  };
  // P2-002 AI-safety gate — same guard emitClarification applies before
  // persisting a voice_clarification, so a future edit that breaks the
  // contract trips here instead of writing a malformed proposal.
  assertValidProposalPayload('voice_clarification', nextPayload);

  // Summary/explanation mirror emitClarification's entityAmbiguity branch
  // (voice-action-router.ts) so this reads exactly like a freshly emitted
  // clarification for the next reference.
  const moreCount = rest.length;
  const summary = `Which ${next.entityKind}? "${next.reference}" matched ${next.candidates.length} records`;
  const explanation =
    `Heard the request, but "${next.reference}" matches more than one ${next.entityKind}. Tap the right one below.` +
    (moreCount > 0
      ? ` (${moreCount} more reference${moreCount === 1 ? '' : 's'} will need picking after this.)`
      : '');

  const nextSourceContext: Record<string, unknown> = { ...sourceContext };
  nextSourceContext.entityKind = next.entityKind;
  nextSourceContext.entityReference = next.reference;
  nextSourceContext.entityCandidates = next.candidates.map((c) => ({
    id: c.id,
    kind: c.kind ?? next.entityKind,
    label: c.label,
    ...(c.hint ? { hint: c.hint } : {}),
    score: c.score,
  }));
  if (rest.length > 0) {
    nextSourceContext.pendingEntityAmbiguities = rest.map((a) => ({
      entityKind: a.entityKind,
      reference: a.reference,
      candidates: a.candidates.map((c) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        ...(c.hint ? { hint: c.hint } : {}),
        score: c.score,
      })),
    }));
  } else {
    delete nextSourceContext.pendingEntityAmbiguities;
  }
  // originalIntent rides forward untouched — the eventual redraft still
  // needs it. Accumulate this pick so the eventual redraft (or annotate
  // fallback) sees every resolution from the chain, not just the last one.
  nextSourceContext.resolvedEntities = resolvedEntities;
  nextSourceContext.resolvedEntity = resolvedEntities[resolvedEntities.length - 1];

  await deps.proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    summary,
    explanation,
    sourceContext: nextSourceContext,
    // Best-effort deep-link target for THIS pick — the redraft overwrites it
    // with whichever entity is resolved last, same as the single-ambiguity
    // path always did.
    targetEntityId: chosen.id,
    ...(entityKind ? { targetEntityType: entityKind } : {}),
  });
  // Deliberately no status transition: this proposal is not resolved, it's
  // still awaiting an operator pick — exactly the state a freshly emitted
  // voice_clarification starts in (emitClarification never sets
  // sourceTrustTier, so it always lands in 'draft'). Promoting to
  // 'ready_for_review' here would misrepresent an open question as an
  // approvable action.

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
          movedToReview: false,
          // Trace which ambiguity this chain advanced to and how many are
          // still queued behind it.
          nextEntityKind: next.entityKind,
          remainingAmbiguities: rest.length,
        },
      }),
    );
  }

  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? proposal;
}
