/**
 * U2 (P2-035) — resolve an ambiguous catalog line.
 *
 * When the catalog resolver can't ground a drafted line to a single tenant SKU
 * it marks the line `pricingSource: 'ambiguous'`, records the candidate SKUs
 * under `sourceContext.catalogResolution[lineIndex]`, and adds
 * `lineItems[i].catalogItemId` to `sourceContext.missingFields` — which keeps
 * the proposal in `draft`. This service is the owner's one-tap resolution: it
 * stamps the CHOSEN catalog item's price onto the line and, when nothing
 * ambiguous remains, moves the proposal to `ready_for_review`.
 *
 * B3 — the SAME contract now also resolves EDIT-ACTION lines
 * (`update_invoice` / `update_estimate` proposals carry `payload.editActions`,
 * not `payload.lineItems`). `ai/resolution/edit-action-grounding.ts` records
 * candidates and `editActions[i].lineItem.catalogItemId` missingFields entries
 * the exact same way `applyCatalogPricing` does for draft lines, under the
 * SAME `sourceContext.catalogResolution` map (keyed by edit-action index —
 * a proposal is either lineItems-shaped or editActions-shaped, never both, so
 * there is no key collision). This module branches on
 * `Array.isArray(payload.editActions)` to decide which array to patch; the
 * route, request body `{lineIndex, catalogItemId}`, and every invariant below
 * are identical for both shapes.
 *
 * Invariants:
 *  - Catalog grounding: the chosen `catalogItemId` MUST be one of the line's
 *    own candidates — never an arbitrary off-catalog price (rejected 400).
 *    This still holds for the `spoken:{index}` carve-out below: it is never
 *    an arbitrary off-catalog price supplied by the RESOLVE caller — it was
 *    recorded as a candidate AT GROUNDING TIME (`applyCatalogPricing` for
 *    draft lines, `groundEditActionPricing` for edit actions) from the
 *    line's own drafted price, before this endpoint ever saw the request.
 *    The caller can still only pick from recorded candidates.
 *  - No auto-execute (D-004): resolution caps at `ready_for_review`; it never
 *    approves or executes. Money proposals still need a deliberate approval.
 *  - Integer cents: the stamped price is the chosen candidate's
 *    `unitPriceCents` — the catalog item's price, OR (for a `spoken:`
 *    candidate) the operator-confirmed spoken price recorded at grounding
 *    time. Either way it's a recorded candidate, never a fresh number.
 *  - Audited: every resolution emits `proposal.line_resolved`.
 */
import { Role, hasPermission } from '../auth/rbac';
import { AuditRepository, createAuditEvent } from '../audit/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../shared/errors';
import { Proposal, ProposalRepository } from './proposal';

interface CatalogCandidate {
  id: string;
  name: string;
  unitPriceCents: number;
  score: number;
  /**
   * Contract category ('labor' | 'material') of the catalog item this
   * candidate represents (see catalog-resolver.ts `contractCategory`).
   * Absent on the synthetic `spoken:` candidate (no catalog identity) and
   * on candidates recorded by proposals persisted before this field
   * existed — both cases are handled by leaving the line's own category
   * untouched.
   */
  category?: string;
}

export interface ResolveLineInput {
  tenantId: string;
  proposalId: string;
  lineIndex: number;
  catalogItemId: string;
  actorId: string;
  actorRole: Role;
}

export interface ResolveLineDeps {
  proposalRepo: ProposalRepository;
  auditRepo?: AuditRepository;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Drop the resolved line's marker from `_meta.markers`. `prefix` is
 * `lineItems[i]` for a draft line or `editActions[i]` for an edit-action
 * line — parametrized (B3) so the same helper serves both shapes; every
 * marker path this module ever stamps is `${prefix}.lineItem.unitPrice` or
 * `${prefix}.unitPrice`, both of which start with `prefix`.
 */
function recomputeMeta(meta: unknown, prefix: string): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const m = { ...(meta as Record<string, unknown>) };
  const markers = m.markers;
  if (Array.isArray(markers)) {
    m.markers = markers.filter((mk) => {
      const path = asRecord(mk).path;
      return typeof path !== 'string' || !path.startsWith(prefix);
    });
  }
  return m;
}

/** Validated shape shared by the lineItems and editActions branches. */
interface ResolvedPick {
  chosen: CatalogCandidate;
  isSpokenPriceChoice: boolean;
}

/**
 * Shared grounding-invariant check: the chosen id must be one of THIS
 * line's recorded candidates — never an arbitrary off-catalog price.
 * Identical for lineItems and editActions (both read the same
 * `sourceContext.catalogResolution[lineIndex]` map).
 */
function pickCandidate(
  catalogResolution: Record<string, CatalogCandidate[]>,
  lineIndex: number,
  catalogItemId: string,
): ResolvedPick {
  const candidates = catalogResolution[String(lineIndex)];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ValidationError(`Line ${lineIndex} is not awaiting a catalog choice`);
  }
  const chosen = candidates.find((c) => c.id === catalogItemId);
  if (!chosen) {
    throw new ValidationError('catalogItemId is not among this line’s candidates');
  }
  return { chosen, isSpokenPriceChoice: catalogItemId.startsWith('spoken:') };
}

export async function resolveProposalLine(
  input: ResolveLineInput,
  deps: ResolveLineDeps,
): Promise<Proposal> {
  const { tenantId, proposalId, lineIndex, catalogItemId, actorId, actorRole } = input;

  // Same authority as approving — resolving a line patches a draft the owner
  // will then approve.
  if (!hasPermission(actorRole, 'proposals:approve')) {
    throw new ForbiddenError();
  }
  if (!Number.isInteger(lineIndex) || lineIndex < 0) {
    throw new ValidationError('lineIndex must be a non-negative integer');
  }
  if (typeof catalogItemId !== 'string' || catalogItemId.length === 0) {
    throw new ValidationError('catalogItemId is required');
  }

  const proposal = await deps.proposalRepo.findById(tenantId, proposalId);
  if (!proposal) {
    throw new NotFoundError('Proposal', proposalId);
  }
  // Only a proposal still under review can be patched — never one already
  // approved/executed (that would mutate an in-flight or committed action).
  if (proposal.status !== 'draft' && proposal.status !== 'ready_for_review') {
    throw new ValidationError(
      `Cannot resolve a line on a proposal in '${proposal.status}' status`,
    );
  }

  const payload = asRecord(proposal.payload);
  const sourceContext = asRecord(proposal.sourceContext);
  const catalogResolution = asRecord(sourceContext.catalogResolution) as Record<
    string,
    CatalogCandidate[]
  >;

  // B3 — edit proposals (update_invoice / update_estimate) carry
  // `editActions`, not `lineItems`; a proposal is one shape or the other,
  // never both, so this check is unambiguous.
  if (Array.isArray(payload.editActions)) {
    return resolveEditActionLine(input, deps, proposal, payload, sourceContext, catalogResolution);
  }

  const lineItems = Array.isArray(payload.lineItems)
    ? [...(payload.lineItems as Array<Record<string, unknown>>)]
    : [];
  if (lineIndex >= lineItems.length) {
    throw new ValidationError(`lineIndex ${lineIndex} is out of range`);
  }

  const { chosen, isSpokenPriceChoice } = pickCandidate(catalogResolution, lineIndex, catalogItemId);

  // Stamp the chosen candidate onto the line. Estimate lines carry the
  // integer-cents price in `unitPrice`; invoice lines in `unitPriceCents`
  // (and a recomputed `totalCents`).
  const line: Record<string, unknown> = { ...lineItems[lineIndex] };
  // Pick the contract's price field. Estimate lines carry integer cents in
  // `unitPrice`; invoice lines in `unitPriceCents` (+ a recomputed totalCents).
  // An ambiguous line the LLM left price-less has NEITHER field, so we can't
  // infer from this line alone — look at sibling lines (an invoice payload
  // prices its other lines in unitPriceCents) and fall back to the proposal
  // type. Guessing wrong would strand the resolved price on a field the
  // executor never reads.
  const usesCents =
    'unitPriceCents' in line ||
    lineItems.some((li) => li && typeof li === 'object' && 'unitPriceCents' in li) ||
    /invoice/.test(proposal.proposalType);
  const priceField = usesCents ? 'unitPriceCents' : 'unitPrice';
  line[priceField] = chosen.unitPriceCents;
  if (isSpokenPriceChoice) {
    // Operator-confirmed spoken price — keep the original description and
    // do NOT claim catalog grounding: this line was never actually matched.
    delete line.catalogItemId;
    line.pricingSource = 'manual';
  } else {
    line.catalogItemId = chosen.id;
    line.description = chosen.name;
    line.pricingSource = 'catalog';
    // Stamp the catalog item's category onto the line so an operator's
    // pick can't leave a material/labor line executing under the LLM's
    // (or the line's prior default) category. Legacy candidates recorded
    // before this field existed carry no `category` — leave the line's
    // category untouched rather than clobbering it with undefined.
    if (chosen.category !== undefined) {
      line.category = chosen.category;
    }
  }
  line.needsPricing = false;
  if (priceField === 'unitPriceCents') {
    // Guard NaN/missing without rebounding a legitimate quantity of 0 to 1
    // (which `Number(...) || 1` would do, mispricing a zero-qty line).
    const parsedQty = Number(line.quantity ?? 1);
    const qty = Number.isNaN(parsedQty) ? 1 : parsedQty;
    line.totalCents = Math.round(chosen.unitPriceCents * qty);
  }
  lineItems[lineIndex] = line;

  // Drop this line's missingField + its candidate set (it's resolved now).
  const remainingMissing = (
    Array.isArray(sourceContext.missingFields)
      ? (sourceContext.missingFields as string[])
      : []
  ).filter((f) => f !== `lineItems[${lineIndex}].catalogItemId`);
  const nextCatalogResolution = { ...catalogResolution };
  delete nextCatalogResolution[String(lineIndex)];

  const nextMeta = recomputeMeta(payload._meta, `lineItems[${lineIndex}]`);
  const nextPayload: Record<string, unknown> = {
    ...payload,
    lineItems,
    ...(nextMeta ? { _meta: nextMeta } : {}),
  };
  const nextSourceContext: Record<string, unknown> = {
    ...sourceContext,
    missingFields: remainingMissing,
    catalogResolution: nextCatalogResolution,
  };

  await deps.proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    sourceContext: nextSourceContext,
  });

  // Once nothing ambiguous remains, surface it for approval — but NEVER
  // approve/execute it (D-004). A money proposal still waits for a deliberate
  // tap.
  let finalProposal: Proposal | null = null;
  if (remainingMissing.length === 0 && proposal.status === 'draft') {
    finalProposal = await deps.proposalRepo.updateStatus(
      tenantId,
      proposalId,
      'ready_for_review',
      {},
    );
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.line_resolved',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          lineIndex,
          catalogItemId,
          unitPriceCents: chosen.unitPriceCents,
          remainingMissingFields: remainingMissing.length,
          movedToReview: finalProposal !== null,
          ...(isSpokenPriceChoice ? { priceOverride: true } : {}),
        },
      }),
    );
  }

  // Re-read so the response reflects both the payload patch and any status
  // transition (the updateStatus result above only fires on the draft→review
  // path).
  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? finalProposal ?? proposal;
}

/**
 * B3 — the editActions counterpart of the lineItems resolution above. Same
 * route, same request body, same invariants (grounding membership, D-004
 * cap, audit event) — only the storage shape differs: the chosen candidate
 * is stamped onto `editActions[lineIndex].lineItem` instead of
 * `lineItems[lineIndex]`, and BOTH price fields are always set (per
 * edit-action-grounding.ts's price-field doctrine: `unitPrice` is the
 * executable field BOTH invoice-editor.ts and estimate-editor.ts read;
 * `unitPriceCents` is the review-UI mirror — unlike draft lineItems, where
 * only ONE of the two fields is the document type's executable field).
 */
async function resolveEditActionLine(
  input: ResolveLineInput,
  deps: ResolveLineDeps,
  proposal: Proposal,
  payload: Record<string, unknown>,
  sourceContext: Record<string, unknown>,
  catalogResolution: Record<string, CatalogCandidate[]>,
): Promise<Proposal> {
  const { tenantId, proposalId, lineIndex, catalogItemId, actorId, actorRole } = input;

  const editActions = [...(payload.editActions as Array<Record<string, unknown>>)];
  if (lineIndex >= editActions.length) {
    throw new ValidationError(`lineIndex ${lineIndex} is out of range`);
  }
  const action = editActions[lineIndex];
  if (
    !action ||
    (action.type !== 'add_line_item' && action.type !== 'update_line_item') ||
    typeof action.lineItem !== 'object' ||
    action.lineItem === null
  ) {
    throw new ValidationError(`editActions[${lineIndex}] has no lineItem to resolve`);
  }

  const { chosen, isSpokenPriceChoice } = pickCandidate(catalogResolution, lineIndex, catalogItemId);

  const lineItem: Record<string, unknown> = { ...(action.lineItem as Record<string, unknown>) };
  // Both price fields are always stamped — unlike the lineItems branch,
  // edit-action lines carry BOTH `unitPrice` (executable, both editors read
  // it) and `unitPriceCents` (review mirror) simultaneously.
  lineItem.unitPrice = chosen.unitPriceCents;
  lineItem.unitPriceCents = chosen.unitPriceCents;
  if (isSpokenPriceChoice) {
    // Operator-confirmed spoken price — keep the original description and
    // do NOT claim catalog grounding: this line was never actually matched.
    delete lineItem.catalogItemId;
    lineItem.pricingSource = 'manual';
  } else {
    lineItem.catalogItemId = chosen.id;
    lineItem.description = chosen.name;
    lineItem.pricingSource = 'catalog';
    if (chosen.category !== undefined) {
      lineItem.category = chosen.category;
    }
  }
  lineItem.needsPricing = false;
  // Parity with groundEditActionPricing's own quantity defaulting: a
  // resolved line always needs a valid quantity for the editors'
  // validateBillingLineItem (an ambiguous/uncatalogued line may have been
  // left without one).
  const parsedQty = Number(lineItem.quantity ?? 1);
  lineItem.quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1;

  editActions[lineIndex] = { ...action, lineItem };

  const gateEntry = `editActions[${lineIndex}].lineItem.catalogItemId`;
  const remainingMissing = (
    Array.isArray(sourceContext.missingFields) ? (sourceContext.missingFields as string[]) : []
  ).filter((f) => f !== gateEntry);
  const nextCatalogResolution = { ...catalogResolution };
  delete nextCatalogResolution[String(lineIndex)];

  const nextMeta = recomputeMeta(payload._meta, `editActions[${lineIndex}]`);
  const nextPayload: Record<string, unknown> = {
    ...payload,
    editActions,
    ...(nextMeta ? { _meta: nextMeta } : {}),
  };
  const nextSourceContext: Record<string, unknown> = {
    ...sourceContext,
    missingFields: remainingMissing,
    catalogResolution: nextCatalogResolution,
  };

  await deps.proposalRepo.update(tenantId, proposalId, {
    payload: nextPayload,
    sourceContext: nextSourceContext,
  });

  // Once nothing outstanding remains, surface it for approval — but NEVER
  // approve/execute it (D-004). This does NOT distinguish an editAction gate
  // from e.g. an unresolved invoiceId/estimateId gate (B2) — both are
  // disjoint entries in the same `missingFields` list, so the proposal only
  // moves to ready_for_review once ALL of them are cleared, whichever
  // resolution endpoint (resolve-line / resolve-entity) clears the last one.
  let finalProposal: Proposal | null = null;
  if (remainingMissing.length === 0 && proposal.status === 'draft') {
    finalProposal = await deps.proposalRepo.updateStatus(tenantId, proposalId, 'ready_for_review', {});
  }

  if (deps.auditRepo) {
    await deps.auditRepo.create(
      createAuditEvent({
        tenantId,
        actorId,
        actorRole,
        eventType: 'proposal.line_resolved',
        entityType: 'proposal',
        entityId: proposalId,
        metadata: {
          lineIndex,
          catalogItemId,
          unitPriceCents: chosen.unitPriceCents,
          remainingMissingFields: remainingMissing.length,
          movedToReview: finalProposal !== null,
          target: 'editAction',
          ...(isSpokenPriceChoice ? { priceOverride: true } : {}),
        },
      }),
    );
  }

  const fresh = await deps.proposalRepo.findById(tenantId, proposalId);
  return fresh ?? finalProposal ?? proposal;
}
