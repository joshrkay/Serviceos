import { Proposal, ProposalRepository, missingFieldsFor } from './proposal';
import { transitionProposal } from './lifecycle';
import { Role, hasPermission } from '../auth/rbac';
import { ForbiddenError, ValidationError, NotFoundError } from '../shared/errors';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import type { ConfidenceLevel } from '../ai/guardrails/confidence';
import { lineItemConfidenceSignals } from '../ai/resolution/catalog-resolver';

/**
 * P2-035 (U2) — resolve ONE ambiguous catalog line on a proposal by
 * picking a candidate the catalog resolver already surfaced.
 *
 * The catalog resolver (ai/resolution/catalog-resolver.ts) stamps an
 * 'ambiguous' line with `pricingSource:'ambiguous'`, adds
 * `lineItems[idx].catalogItemId` to the proposal's `missingFields`, and
 * stores the top candidates under `sourceContext.catalogResolution[idx]`
 * (`{ id, name, unitPriceCents, score }`, max 3). An uncertain match must
 * never silently set a price, so the operator picks the right item here.
 *
 * Catalog-grounding invariant (CLAUDE.md): only a candidate the resolver
 * surfaced is acceptable. A `catalogItemId` not in that list is rejected
 * (400) — we never accept an off-catalog price.
 *
 * This service patches the draft and stops at `ready_for_review`. It MUST
 * NOT approve or execute — D-004, human approval is still required.
 */

/** The per-line candidate shape stored under `sourceContext.catalogResolution`. */
interface StoredCatalogCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
}

export interface ResolveLineInput {
  lineIndex: number;
  catalogItemId: string;
}

type CatalogResolutionMap = Record<string, StoredCatalogCandidate[]>;

/** Read the per-line candidate list, tolerating the JSONB string/number key. */
function candidatesForLine(
  proposal: Proposal,
  lineIndex: number,
): StoredCatalogCandidate[] | undefined {
  const ctx = proposal.sourceContext as Record<string, unknown> | undefined;
  const resolution = ctx?.catalogResolution as CatalogResolutionMap | undefined;
  if (!resolution || typeof resolution !== 'object') return undefined;
  // catalogResolution is keyed by line index; JSON object keys are strings,
  // so look up by both forms to be robust to how the row was serialized.
  const byNum = resolution[lineIndex as unknown as keyof CatalogResolutionMap];
  const byStr = resolution[String(lineIndex)];
  const list = byNum ?? byStr;
  return Array.isArray(list) ? list : undefined;
}

/**
 * Which price field this proposal's line items carry. The estimate
 * contract uses `unitPrice` (integer cents); the invoice contract
 * normalizes to `unitPriceCents` and carries `totalCents` per line.
 */
function priceFieldFor(proposalType: string): 'unitPrice' | 'unitPriceCents' {
  return proposalType === 'draft_invoice' || proposalType === 'update_invoice'
    ? 'unitPriceCents'
    : 'unitPrice';
}

/**
 * Recompute the payload `_meta` after a line is resolved: re-derive the
 * per-field signals / markers from the (mutated) line items via the same
 * `lineItemConfidenceSignals` the AI task uses (single source of truth —
 * the resolved ambiguity drops out automatically). `overallConfidence` is
 * downgraded to 'low' while any low-certainty line remains but is never
 * UPGRADED here — resolving a line removes uncertainty, it does not raise
 * the underlying model score, so we fall back to the prior overall level.
 */
function recomputeMeta(
  lineItems: Array<Record<string, unknown>>,
  priceField: 'unitPrice' | 'unitPriceCents',
  priorOverall: ConfidenceLevel | undefined,
): {
  overallConfidence: ConfidenceLevel;
  fieldConfidence?: Record<string, ConfidenceLevel>;
  markers?: Array<{ path: string; reason: string }>;
} {
  const { fieldConfidence, markers } = lineItemConfidenceSignals(lineItems, priceField);

  // Any remaining low-certainty line keeps the proposal at 'low'. With none
  // left, fall back to the prior overall level (resolving a line never
  // *raises* the underlying model confidence). Default 'medium' when unknown.
  const overallConfidence: ConfidenceLevel =
    markers.length > 0 ? 'low' : (priorOverall ?? 'medium');

  return {
    overallConfidence,
    ...(Object.keys(fieldConfidence).length > 0 ? { fieldConfidence } : {}),
    ...(markers.length > 0 ? { markers } : {}),
  };
}

/**
 * Resolve a single ambiguous catalog line, stamping the chosen candidate's
 * price (integer cents, never a float) and moving the proposal to
 * `ready_for_review` once no required fields remain. Never approves.
 */
export async function resolveProposalLine(
  proposalRepo: ProposalRepository,
  tenantId: string,
  proposalId: string,
  actorId: string,
  actorRole: Role,
  input: ResolveLineInput,
  auditRepo?: AuditRepository,
): Promise<Proposal> {
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }

  const { lineIndex, catalogItemId } = input;

  const proposal = await proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }

  const lineItems = proposal.payload.lineItems;
  if (!Array.isArray(lineItems) || lineIndex < 0 || lineIndex >= lineItems.length) {
    throw new ValidationError(`Invalid lineIndex ${lineIndex} for proposal ${proposalId}`);
  }

  // Catalog-grounding guard: the chosen item MUST be one the resolver
  // surfaced for this line. Without candidates there is nothing to resolve;
  // a catalogItemId outside the list would accept an off-catalog price.
  const candidates = candidatesForLine(proposal, lineIndex);
  if (!candidates || candidates.length === 0) {
    throw new ValidationError(
      `Line ${lineIndex} has no ambiguous catalog candidates to resolve`,
    );
  }
  const chosen = candidates.find((c) => c.id === catalogItemId);
  if (!chosen) {
    throw new ValidationError(
      `catalogItemId '${catalogItemId}' is not among the candidates for line ${lineIndex}`,
      { candidateIds: candidates.map((c) => c.id) },
    );
  }

  const priceField = priceFieldFor(proposal.proposalType);

  // Stamp the catalog price (integer cents) onto the chosen line and mark
  // it catalog-grounded. Clone so we never mutate the stored payload object.
  const nextLineItems = lineItems.map((li, idx) => {
    if (idx !== lineIndex) return li as Record<string, unknown>;
    const line = li as Record<string, unknown>;
    const next: Record<string, unknown> = {
      ...line,
      description: chosen.name,
      [priceField]: chosen.unitPriceCents,
      catalogItemId: chosen.id,
      pricingSource: 'catalog',
      needsPricing: false,
    };
    if (priceField === 'unitPriceCents') {
      const qty = Number(line.quantity ?? 1) || 1;
      next.totalCents = Math.round(chosen.unitPriceCents * qty);
    }
    return next;
  });

  // Clear THIS line's missingField entry (other unresolved lines stay).
  const resolvedField = `lineItems[${lineIndex}].catalogItemId`;
  const remainingMissing = missingFieldsFor(proposal).filter((f) => f !== resolvedField);

  // Drop this line from the stored candidate map so the UI no longer offers
  // a picker for an already-resolved line.
  const ctx = (proposal.sourceContext ?? {}) as Record<string, unknown>;
  const priorResolution = (ctx.catalogResolution ?? {}) as CatalogResolutionMap;
  const nextResolution: CatalogResolutionMap = {};
  for (const [key, value] of Object.entries(priorResolution)) {
    if (key !== String(lineIndex)) nextResolution[key] = value;
  }

  // Recompute `_meta` from the mutated lines — the resolved ambiguity drops
  // out, and overallConfidence is re-derived from what remains.
  const priorMeta = proposal.payload._meta as
    | { overallConfidence?: ConfidenceLevel }
    | undefined;
  const nextMeta = recomputeMeta(
    nextLineItems as Array<Record<string, unknown>>,
    priceField,
    priorMeta?.overallConfidence,
  );

  const nextSourceContext: Record<string, unknown> = {
    ...ctx,
    ...(remainingMissing.length > 0 ? { missingFields: remainingMissing } : {}),
    ...(Object.keys(nextResolution).length > 0
      ? { catalogResolution: nextResolution }
      : {}),
  };
  // Strip emptied keys so a fully-resolved proposal carries no stale signal.
  if (remainingMissing.length === 0) delete nextSourceContext.missingFields;
  if (Object.keys(nextResolution).length === 0) delete nextSourceContext.catalogResolution;

  const nextPayload: Record<string, unknown> = {
    ...proposal.payload,
    lineItems: nextLineItems,
    _meta: nextMeta,
  };

  const updated = await proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    sourceContext: nextSourceContext,
  });
  if (!updated) {
    throw new NotFoundError('Proposal', proposalId);
  }

  // Move to ready_for_review IFF nothing is still missing AND we're in
  // 'draft'. NEVER approve/execute — D-004, a human still confirms. A
  // proposal already in 'ready_for_review' stays there; other statuses are
  // left untouched (this path only resolves draftable proposals).
  let finalProposal = updated;
  if (remainingMissing.length === 0 && updated.status === 'draft') {
    const transitioned = transitionProposal(updated, 'ready_for_review', actorId);
    const promoted = await proposalRepo.updateStatus(
      tenantId,
      proposalId,
      'ready_for_review',
    );
    // transitioned drives the in-memory shape; updateStatus persists it.
    finalProposal = promoted ?? { ...updated, status: transitioned.status };
  }

  if (auditRepo) {
    await auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.line_resolved',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          proposalType: finalProposal.proposalType,
          status: finalProposal.status,
          lineIndex,
          catalogItemId,
          unitPriceCents: chosen.unitPriceCents,
          remainingMissingFields: remainingMissing,
        },
      }),
    );
  }

  return finalProposal;
}
