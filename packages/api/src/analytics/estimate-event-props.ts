/**
 * Pure derivations of the PostHog-safe props carried on estimate audit
 * metadata (EE-4 images + EE-1 tiers/selection). These live here — not inline
 * in the emitters — so the "what counts as a tier / an add-on / an upsell"
 * logic is unit-tested in one place and stays identical across the create and
 * approve paths.
 *
 * Everything returned is a count or a boolean. No URLs, file ids, line-item
 * text, or money figures leak: the mapper (`audit-event-mapping.ts`) forwards
 * these by name, and PII discipline is enforced upstream by `pickMeta`.
 */
import type { LineItem } from '../shared/billing-engine';

/** The subset of a line item these summaries read. */
type SummaryLine = Pick<LineItem, 'imageFileId' | 'groupKey' | 'isOptional'>;

export interface EstimateCreatedProps {
  /** Total number of line items on the estimate. */
  lineItemsTotal: number;
  /** How many of those lines carry a catalog/manual image (EE-4 adoption). */
  lineItemsWithImage: number;
  /** Whether the estimate offers any good-better-best tier group (EE-1). */
  hasTiers: boolean;
  /** Distinct tier groups (`groupKey`) offered. */
  tierGroupCount: number;
  /** Standalone optional add-ons (optional, not part of a tier group). */
  addonCount: number;
}

/**
 * Summarize a just-created estimate's line items for the `estimate.created`
 * product event. A tier option is any line with a `groupKey`; a standalone
 * add-on is an `isOptional` line WITHOUT a `groupKey` (so a tier option is
 * never double-counted as an add-on).
 */
export function estimateCreatedProps(
  lineItems: ReadonlyArray<SummaryLine>,
): EstimateCreatedProps {
  const groupKeys = new Set<string>();
  let lineItemsWithImage = 0;
  let addonCount = 0;
  for (const li of lineItems) {
    if (li.imageFileId) lineItemsWithImage += 1;
    if (li.groupKey) {
      groupKeys.add(li.groupKey);
    } else if (li.isOptional) {
      addonCount += 1;
    }
  }
  return {
    lineItemsTotal: lineItems.length,
    lineItemsWithImage,
    hasTiers: groupKeys.size > 0,
    tierGroupCount: groupKeys.size,
    addonCount,
  };
}

export interface EstimateApprovedProps {
  /** Did the accepted estimate carry any line-item photos (EE-4 impact). */
  hadLineItemImages: boolean;
  /** Did the estimate offer good-better-best tiers (EE-1). */
  hadTiers: boolean;
  /**
   * Did the customer's final selection cost MORE than the default headline —
   * i.e. they upgraded a tier or added an un-prechecked add-on. Comparing the
   * server-resolved accepted total to the stored (default-selection) quoted
   * total captures both forms of upsell; a flat estimate accepts at the quoted
   * total, so this is false.
   */
  upsoldAboveDefault: boolean;
}

/**
 * Summarize an accepted estimate for the `public_estimate.approved` product
 * event. `quotedTotalCents` is the stored (default-selection) headline total;
 * `acceptedTotalCents` is the server-resolved total for what the customer
 * actually selected. Both are integer cents.
 */
export function estimateApprovedProps(params: {
  lineItems: ReadonlyArray<Pick<LineItem, 'imageFileId' | 'groupKey'>>;
  quotedTotalCents: number;
  acceptedTotalCents: number;
}): EstimateApprovedProps {
  const hadTiers = params.lineItems.some((li) => Boolean(li.groupKey));
  return {
    hadLineItemImages: params.lineItems.some((li) => Boolean(li.imageFileId)),
    hadTiers,
    upsoldAboveDefault: params.acceptedTotalCents > params.quotedTotalCents,
  };
}
