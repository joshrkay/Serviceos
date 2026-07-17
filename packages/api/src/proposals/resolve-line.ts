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
 * Invariants:
 *  - Catalog grounding: the chosen `catalogItemId` MUST be one of the line's
 *    own candidates — never an arbitrary off-catalog price (rejected 400).
 *    This still holds for the `spoken:{index}` carve-out below: it is never
 *    an arbitrary off-catalog price supplied by the RESOLVE caller — it was
 *    recorded as a candidate AT GROUNDING TIME (`applyCatalogPricing`) from
 *    the line's own drafted price, before this endpoint ever saw the
 *    request. The caller can still only pick from recorded candidates.
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

/** Drop the resolved line's marker from `_meta.markers`, leaving the rest. */
function recomputeMeta(meta: unknown, lineIndex: number): Record<string, unknown> | undefined {
  if (meta === null || typeof meta !== 'object') return undefined;
  const m = { ...(meta as Record<string, unknown>) };
  const markers = m.markers;
  if (Array.isArray(markers)) {
    const prefix = `lineItems[${lineIndex}]`;
    m.markers = markers.filter((mk) => {
      const path = asRecord(mk).path;
      return typeof path !== 'string' || !path.startsWith(prefix);
    });
  }
  return m;
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
  const lineItems = Array.isArray(payload.lineItems)
    ? [...(payload.lineItems as Array<Record<string, unknown>>)]
    : [];
  if (lineIndex >= lineItems.length) {
    throw new ValidationError(`lineIndex ${lineIndex} is out of range`);
  }

  const sourceContext = asRecord(proposal.sourceContext);
  const catalogResolution = asRecord(sourceContext.catalogResolution) as Record<
    string,
    CatalogCandidate[]
  >;
  const candidates = catalogResolution[String(lineIndex)];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ValidationError(`Line ${lineIndex} is not awaiting a catalog choice`);
  }

  // Catalog-grounding invariant: the choice must be one of THIS line's
  // candidates — never an arbitrary off-catalog price.
  const chosen = candidates.find((c) => c.id === catalogItemId);
  if (!chosen) {
    throw new ValidationError(
      'catalogItemId is not among this line’s candidates',
    );
  }

  // A `spoken:{index}` candidate is the honest carve-out: the owner
  // deliberately chose to keep their own quoted price over the catalog's.
  // It was recorded as a candidate AT GROUNDING TIME (applyCatalogPricing)
  // from the line's own drafted price — not supplied fresh by this caller
  // — so the "only pick from recorded candidates" invariant still holds.
  const isSpokenPriceChoice = catalogItemId.startsWith('spoken:');

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

  const nextMeta = recomputeMeta(payload._meta, lineIndex);
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
