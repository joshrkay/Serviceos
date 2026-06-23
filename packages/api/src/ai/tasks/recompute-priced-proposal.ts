/**
 * Shared catalog-grounding + confidence sequence for priced *draft*
 * proposals (draft_estimate / draft_invoice), used by BOTH the draft-time
 * task handlers (ai/tasks/estimate-task.ts, ai/tasks/invoice-task.ts) and
 * the edit-time recompute (proposals/actions.ts → editProposal).
 *
 * Pure and deterministic (no I/O, no LLM) — callers pre-load the active
 * tenant catalog. Extracting the sequence here is the single source of
 * truth: the draft handlers and the edit path can never drift in how a
 * line item is grounded, how the two catalog confidence factors are
 * reconciled, or how the `_meta` marker is built.
 *
 * Money-correctness property (D-004 / catalog grounding): editProposal used
 * to re-validate a payload's *shape* but never re-scored it, so a human
 * could edit a catalog-grounded line into an uncatalogued (LLM-priced) one
 * and the proposal would keep its stale ≥0.9 confidence — re-arming
 * autonomous auto-approval on an un-grounded price. Re-grounding on edit
 * caps confidence at UNCATALOGUED_CONFIDENCE_CAP (0.85 < the 0.9 floor) the
 * moment any line is uncatalogued. Confidence is only ever HELD or LOWERED
 * here, never raised, so an edit can never grant fresh auto-approve
 * eligibility.
 */
import type { CatalogItem } from '../../catalog/catalog-item';
import {
  applyCatalogPricing,
  CatalogPricingOutcome,
  lineItemConfidenceSignals,
  resolveLineItems,
  UNCATALOGUED_CONFIDENCE_CAP,
} from '../resolution/catalog-resolver';
import { getConfidenceLevel } from '../guardrails/confidence';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';

type PriceField = 'unitPrice' | 'unitPriceCents';

/**
 * Proposal types whose payload carries directly-priced root `lineItems`,
 * mapped to the price field that producer uses (the estimate path emits
 * `unitPrice`, the invoice path `unitPriceCents`; see proposals/contracts.ts).
 * The `update_estimate` / `update_invoice` editAction proposals carry a
 * different (nested) shape and are intentionally out of scope here.
 */
const PRICED_DRAFT_PRICE_FIELD: Record<string, PriceField> = {
  draft_estimate: 'unitPrice',
  draft_invoice: 'unitPriceCents',
};

export function isPricedDraftType(proposalType: string): boolean {
  return proposalType in PRICED_DRAFT_PRICE_FIELD;
}

export interface CatalogGroundingResult {
  lineItems: Array<Record<string, unknown>>;
  confidenceScore: number;
  confidenceFactors: string[];
  outcome?: CatalogPricingOutcome;
}

/**
 * Re-ground line items against the preloaded tenant catalog, then reconcile
 * the two catalog-derived confidence factors and apply the uncatalogued cap.
 * Shared by the draft handlers and the edit path so grounding can never drift.
 *
 * `baseFactors` may already carry `catalog_priced` / `uncatalogued_line_item`
 * from a prior grounding (repeated edits) — they are stripped and rebuilt from
 * the fresh outcome so they never accumulate or go stale. Confidence is only
 * ever held or LOWERED (capped) here, never raised.
 */
export function applyCatalogGrounding(params: {
  lineItems: Array<Record<string, unknown>>;
  catalogItems: CatalogItem[];
  priceField: PriceField;
  baseScore: number;
  baseFactors: string[];
}): CatalogGroundingResult {
  const { lineItems, catalogItems, priceField, baseScore, baseFactors } = params;

  let outcome: CatalogPricingOutcome | undefined;
  let grounded = lineItems;
  if (catalogItems.length > 0 && lineItems.length > 0) {
    const resolutions = resolveLineItems(
      lineItems.map((li) => String(li.description ?? '')),
      catalogItems,
    );
    outcome = applyCatalogPricing(lineItems, resolutions, priceField);
    grounded = outcome.lineItems;
  }

  let confidenceScore = baseScore;
  // Rebuild the catalog-derived factors so repeated edits don't accumulate
  // duplicates; non-catalog factors (the original AI assess) are preserved.
  const confidenceFactors = baseFactors.filter(
    (f) => f !== 'catalog_priced' && f !== 'uncatalogued_line_item',
  );
  if (outcome?.anyCatalogPriced) confidenceFactors.push('catalog_priced');
  if (outcome?.anyUncatalogued) {
    confidenceFactors.push('uncatalogued_line_item');
    // Money-correctness gate: an AI-invented price must never ride a ≥0.9
    // confidence score into autonomous auto-approval.
    confidenceScore = Math.min(confidenceScore, UNCATALOGUED_CONFIDENCE_CAP);
  }

  return { lineItems: grounded, confidenceScore, confidenceFactors, outcome };
}

/**
 * RV-007 — build the payload `_meta` confidence marker. Overall level is the
 * mapped (post-cap) score; per-field signals re-express the catalog resolver's
 * pricingSource outcomes. Call with the FINAL line items (after any drop pass)
 * so the `lineItems[i]` paths index the stored payload. No new confidence
 * computation. Shared by the draft handlers and the edit path.
 */
export function buildConfidenceMeta(
  lineItems: Array<Record<string, unknown>>,
  priceField: PriceField,
  score: number,
): ProposalConfidenceMeta {
  const signals = lineItemConfidenceSignals(lineItems, priceField);
  return {
    overallConfidence: getConfidenceLevel(score),
    ...(Object.keys(signals.fieldConfidence).length > 0
      ? { fieldConfidence: signals.fieldConfidence }
      : {}),
    ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
  };
}

export interface RecomputeResult {
  payload: Record<string, unknown>;
  confidenceScore: number;
  confidenceFactors: string[];
}

export function recomputePricedProposalOnEdit(params: {
  proposalType: string;
  payload: Record<string, unknown>;
  catalogItems: CatalogItem[];
  currentConfidenceScore?: number;
  currentConfidenceFactors?: string[];
}): RecomputeResult {
  const { proposalType, payload, catalogItems } = params;
  const priceField = PRICED_DRAFT_PRICE_FIELD[proposalType];
  const baseScore = params.currentConfidenceScore ?? 1;
  const baseFactors = params.currentConfidenceFactors ?? [];

  const lineItems = Array.isArray(payload.lineItems)
    ? (payload.lineItems as Array<Record<string, unknown>>)
    : null;

  // Nothing to re-ground (non-priced type, no catalog, or no line items).
  // Still resync `_meta.overallConfidence` from the current score so the
  // marker can never be stale relative to the persisted confidence.
  if (!priceField || !lineItems || lineItems.length === 0 || catalogItems.length === 0) {
    const refreshed: Record<string, unknown> = { ...payload };
    const existingMeta = refreshed._meta;
    if (existingMeta !== null && typeof existingMeta === 'object') {
      refreshed._meta = {
        ...(existingMeta as ProposalConfidenceMeta),
        overallConfidence: getConfidenceLevel(baseScore),
      };
    }
    return {
      payload: refreshed,
      confidenceScore: baseScore,
      confidenceFactors: baseFactors,
    };
  }

  const grounded = applyCatalogGrounding({
    lineItems,
    catalogItems,
    priceField,
    baseScore,
    baseFactors,
  });

  // Invoice lines carry a per-line `totalCents` (the estimate contract does
  // not). The draft path keeps it consistent via normalization +
  // applyCatalogPricing; the edit path has no normalization step, so resync it
  // here from the (possibly catalog-overridden) unit price — a quantity or
  // price edit must never leave a stale line total. Integer cents.
  const finalLineItems =
    priceField === 'unitPriceCents'
      ? grounded.lineItems.map((li) => {
          const cents = Number(li.unitPriceCents);
          if (!Number.isFinite(cents)) return li;
          const qty = Number(li.quantity ?? 1) || 1;
          return { ...li, totalCents: Math.round(cents * qty) };
        })
      : grounded.lineItems;

  const meta = buildConfidenceMeta(finalLineItems, priceField, grounded.confidenceScore);

  return {
    payload: { ...payload, lineItems: finalLineItems, _meta: meta },
    confidenceScore: grounded.confidenceScore,
    confidenceFactors: grounded.confidenceFactors,
  };
}
