import type { ProposalType } from '../../proposals/proposal';
import type { CatalogItemRepository } from '../../catalog/catalog-item';
import type { ProposalConfidenceMeta } from '../../proposals/contracts';
import { assessConfidence, getConfidenceLevel } from '../guardrails/confidence';
import {
  applyCatalogPricing,
  type CatalogPricingOutcome,
  lineItemConfidenceSignals,
  resolveLineItems,
  UNCATALOGUED_CONFIDENCE_CAP,
} from '../resolution/catalog-resolver';

export function isPricedDraftType(type: ProposalType): boolean {
  return type === 'draft_estimate' || type === 'draft_invoice';
}

export interface RecomputePricedProposalInput {
  tenantId: string;
  proposalType: ProposalType;
  payload: Record<string, unknown>;
  confidenceScore?: number;
  confidenceFactors?: string[];
  /** LLM parse object for draft-time assessConfidence; omit on edit. */
  parsedForConfidence?: Record<string, unknown>;
}

export interface RecomputePricedProposalResult {
  payload: Record<string, unknown>;
  confidenceScore: number;
  confidenceFactors: string[];
  catalogOutcome?: CatalogPricingOutcome;
  missingFields?: string[];
}

async function loadActiveCatalog(
  catalogRepo: CatalogItemRepository,
  tenantId: string,
) {
  const items = await catalogRepo.listByTenant(tenantId);
  return items.filter((i) => i.archivedAt === null);
}

function stampConfidenceMeta(
  payload: Record<string, unknown>,
  confidenceScore: number,
  priceField: 'unitPrice' | 'unitPriceCents',
): void {
  const lineItems = Array.isArray(payload.lineItems)
    ? (payload.lineItems as Array<Record<string, unknown>>)
    : [];
  const signals = lineItemConfidenceSignals(lineItems, priceField);
  const meta: ProposalConfidenceMeta = {
    overallConfidence: getConfidenceLevel(confidenceScore),
    ...(Object.keys(signals.fieldConfidence).length > 0
      ? { fieldConfidence: signals.fieldConfidence }
      : {}),
    ...(signals.markers.length > 0 ? { markers: signals.markers } : {}),
  };
  payload._meta = meta;
}

function applyCatalogConfidenceCaps(
  confidenceScore: number,
  confidenceFactors: string[],
  catalogOutcome?: CatalogPricingOutcome,
): number {
  let score = confidenceScore;
  if (catalogOutcome?.anyCatalogPriced) confidenceFactors.push('catalog_priced');
  if (catalogOutcome?.anyUncatalogued) {
    confidenceFactors.push('uncatalogued_line_item');
    score = Math.min(score, UNCATALOGUED_CONFIDENCE_CAP);
  }
  return score;
}

/**
 * Shared catalog grounding + confidence + `_meta` for priced draft proposals.
 * Deterministic — no LLM gateway call.
 */
export async function recomputePricedProposal(
  catalogRepo: CatalogItemRepository | undefined,
  input: RecomputePricedProposalInput,
): Promise<RecomputePricedProposalResult> {
  if (!isPricedDraftType(input.proposalType)) {
    return {
      payload: input.payload,
      confidenceScore: input.confidenceScore ?? 0.5,
      confidenceFactors: [...(input.confidenceFactors ?? [])],
    };
  }

  const payload = { ...input.payload };
  const priceField = input.proposalType === 'draft_invoice' ? 'unitPriceCents' : 'unitPrice';
  let catalogOutcome: CatalogPricingOutcome | undefined;

  const lineItems = payload.lineItems as Array<Record<string, unknown>> | undefined;
  if (catalogRepo && Array.isArray(lineItems) && lineItems.length > 0) {
    try {
      const items = await loadActiveCatalog(catalogRepo, input.tenantId);
      if (items.length > 0) {
        const resolutions = resolveLineItems(
          lineItems.map((li) => String(li.description ?? '')),
          items,
        );
        catalogOutcome = applyCatalogPricing(lineItems, resolutions, priceField);
        payload.lineItems = catalogOutcome.lineItems;
      }
    } catch {
      catalogOutcome = undefined;
    }
  }

  const confidence = assessConfidence(input.parsedForConfidence ?? payload);
  let confidenceScore = input.confidenceScore ?? confidence.score;
  const confidenceFactors = [...(input.confidenceFactors ?? confidence.factors)];
  confidenceScore = applyCatalogConfidenceCaps(confidenceScore, confidenceFactors, catalogOutcome);
  stampConfidenceMeta(payload, confidenceScore, priceField);

  return {
    payload,
    confidenceScore,
    confidenceFactors,
    catalogOutcome,
    ...(catalogOutcome && catalogOutcome.missingFields.length > 0
      ? { missingFields: catalogOutcome.missingFields }
      : {}),
  };
}

/** Edit-path entry: re-ground after a human merges payload edits. */
export async function recomputePricedProposalOnEdit(
  catalogRepo: CatalogItemRepository | undefined,
  input: RecomputePricedProposalInput,
): Promise<RecomputePricedProposalResult> {
  return recomputePricedProposal(catalogRepo, input);
}
