import { createProposal, CreateProposalInput, Proposal } from '../../../proposals/proposal';
import { assessConfidence, ConfidenceMetadata } from '../../guardrails/confidence';
import {
  ServiceCategoryExtraction,
  PricingExtraction,
  CategoryMatch,
  PriceEntry,
  OnboardingEstimateTemplatePayload,
  TemplateLineItemPayload,
} from './types';

export interface TemplateAssemblerResult {
  proposals: Proposal[];
}

/**
 * P4-EXT-007: Assemble estimate templates from extracted categories and pricing.
 *
 * - Detailed input (multi-component description) → multi-line-item template
 * - Sparse input (single price mention) → single-line-item template
 * - Never hallucinate line items not described
 */
export function assembleEstimateTemplates(
  tenantId: string,
  userId: string,
  categories: ServiceCategoryExtraction,
  pricing: PricingExtraction,
  conversationId?: string
): TemplateAssemblerResult {
  const proposals: Proposal[] = [];

  for (const category of categories.categories) {
    const matchedPrices = findPricesForCategory(category, pricing.prices);
    const lineItems = buildLineItems(category, matchedPrices);

    // Finding #1 (review) — when nothing captured lexically matches this
    // category (e.g. category "AC Repair", spoken price "$85 per hour"
    // against service ref "labor" — a realistic non-match, not an edge
    // case), we still surface a template rather than dropping the category
    // silently. But a $0 default price is a MONEY defect if it is ever
    // approved as-is: approving installs the template, and its
    // defaultUnitPriceCents flows straight into future estimates as a
    // free line. `needsPriceGate` puts `missingFields: ['lineItems']` on
    // the CreateProposalInput built below — it has to be stamped HERE, not
    // by the caller, because `onboarding-conversation.ts` persists these
    // proposals directly via `proposalRepo.create` and never passes them
    // through the `inputs` path where the other proposal kinds get their
    // gating. That bypass is what let a $0 template reach an approvable
    // card in the first place. `lineItems` is a real top-level key of
    // `onboardingEstimateTemplatePayloadSchema` (proposals/contracts/
    // onboarding.ts), so `editProposal`'s flat-key clear-on-fill (see
    // missing-fields.ts) lifts the gate the instant the operator supplies
    // a priced `lineItems` array and re-validates against that schema —
    // same instrument as the `onboarding_team_member` `email` gate below,
    // applied here because it is the same shape: an approvable card that
    // cannot succeed (well, WOULD succeed here, silently, at $0 — arguably
    // worse than an execution failure, since nothing ever surfaces it).
    let needsPriceGate = false;
    if (lineItems.length === 0) {
      // Create a placeholder template with no default pricing
      needsPriceGate = true;
      lineItems.push({
        description: category.name,
        defaultQuantity: 1,
        defaultUnitPriceCents: 0,
        taxable: true,
        sortOrder: 0,
      });
    }

    const payload: OnboardingEstimateTemplatePayload = {
      verticalType: category.verticalType,
      categoryId: category.categoryId,
      templateName: category.name,
      lineItems,
    };

    const confidence = assessConfidence({
      confidence_score: Math.min(
        category.confidence,
        matchedPrices.length > 0 ? Math.max(...matchedPrices.map((p) => p.confidence)) : 0.3
      ),
      category: category.categoryId,
      prices: matchedPrices,
    });

    const summary = `Estimate template: ${category.name} (${category.verticalType})`;

    const input: CreateProposalInput = {
      tenantId,
      proposalType: 'onboarding_estimate_template',
      payload: payload as unknown as Record<string, unknown>,
      summary,
      confidenceScore: confidence.score,
      confidenceFactors: confidence.factors,
      sourceContext: conversationId ? { conversationId } : undefined,
      createdBy: userId,
      ...(needsPriceGate ? { missingFields: ['lineItems'] } : {}),
    };

    proposals.push(createProposal(input));
  }

  return { proposals };
}

function findPricesForCategory(category: CategoryMatch, prices: PriceEntry[]): PriceEntry[] {
  const categoryLower = category.name.toLowerCase();
  const categoryIdLower = category.categoryId.toLowerCase();

  return prices.filter((p) => {
    const refLower = p.serviceRef.toLowerCase();
    return (
      refLower.includes(categoryLower) ||
      categoryLower.includes(refLower) ||
      refLower.includes(categoryIdLower) ||
      categoryIdLower.includes(refLower)
    );
  });
}

function buildLineItems(category: CategoryMatch, prices: PriceEntry[]): TemplateLineItemPayload[] {
  if (prices.length === 0) return [];

  return prices.map((price, index) => {
    const description = price.serviceRef || category.name;
    return {
      description,
      category: inferLineItemCategory(price),
      defaultQuantity: price.priceType === 'hourly_rate' ? 1 : 1,
      defaultUnitPriceCents: price.amountCents,
      taxable: true,
      sortOrder: index,
    };
  });
}

function inferLineItemCategory(price: PriceEntry): 'labor' | 'material' | 'equipment' | 'other' {
  const ref = price.serviceRef.toLowerCase();
  if (ref.includes('labor') || ref.includes('hour') || price.priceType === 'hourly_rate') {
    return 'labor';
  }
  if (ref.includes('filter') || ref.includes('part') || ref.includes('material')) {
    return 'material';
  }
  if (ref.includes('unit') || ref.includes('equipment') || ref.includes('system')) {
    return 'equipment';
  }
  return 'other';
}
