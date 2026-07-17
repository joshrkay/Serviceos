// Shared billing engine for estimates and invoices
// All money values are integer cents. Tax rate in basis points (bps).

export type LineItemCategory = 'labor' | 'material' | 'equipment' | 'other';

/**
 * Where a line item's price came from, carried from proposal drafting
 * (the catalog resolver stamps it — see
 * ai/resolution/catalog-resolver.ts) through to persistence on
 * estimate_line_items.pricing_source. ESTIMATES ONLY: invoices never set
 * this (the column lives on estimate_line_items), so it stays optional
 * and reads back undefined on invoice lines. A later step uses it to
 * decide whether an estimate's pricing is catalog-grounded enough to
 * auto-allow a discount.
 */
export type PricingSource = 'catalog' | 'ambiguous' | 'uncatalogued' | 'manual';

export interface LineItem {
  id: string;
  description: string;
  category?: LineItemCategory;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
  /**
   * Catalog-grounding signal (estimates only). Set by the catalog
   * resolver during proposal drafting and persisted on estimate line
   * items; undefined/absent on invoice lines and on legacy estimate rows
   * (treated as NOT grounded — see isEstimateCatalogGrounded).
   */
  pricingSource?: PricingSource;
  /**
   * Good-better-best grouping. Items sharing a non-null `groupKey` are
   * mutually exclusive tiers — the customer selects exactly one per group.
   * Null = not part of a tier group.
   */
  groupKey?: string;
  /** Human-readable label for the tier group (e.g. "Roofing tier"). */
  groupLabel?: string;
  /**
   * When true the item is customer-selectable: a tier option (with a
   * groupKey) or a standalone add-on (without one). When false (the
   * default) the item is always billed.
   */
  isOptional?: boolean;
  /** Pre-selected on first view (default tier / pre-checked add-on). */
  isDefaultSelected?: boolean;
}

export interface DocumentTotals {
  subtotalCents: number;
  discountCents: number;
  taxRateBps: number;
  taxableSubtotalCents: number;
  taxCents: number;
  /**
   * Optional processing-fee surcharge (Jobber parity). Basis points applied to
   * the chargeable amount (subtotal − discount + tax) to pass card/ACH
   * processing costs through to the customer. Absent/0 ⇒ no surcharge.
   * Invoice-only today (estimates never pass a fee); the fields are optional so
   * every existing DocumentTotals literal stays valid.
   */
  processingFeeBps?: number;
  processingFeeCents?: number;
  totalCents: number;
}

export function calculateLineItemTotal(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

/**
 * Apply a basis-points rate to an integer-cents amount, rounded to the
 * nearest cent. 10000 bps = 100%. This is the single home for
 * percentage-of-money math (tax lines, deposit rules, discounts) so the
 * rounding convention can never drift between call sites — see CLAUDE.md
 * "Use the shared billing engine for all financial calculations."
 */
export function applyBps(amountCents: number, bps: number): number {
  return Math.round((amountCents * bps) / 10000);
}

export function calculateDocumentTotals(
  lineItems: LineItem[],
  discountCents: number,
  taxRateBps: number,
  processingFeeBps: number = 0
): DocumentTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxableSubtotalCents = lineItems
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.totalCents, 0);

  // Apply discount to taxable amount before computing tax
  const effectiveTaxableAmount = Math.max(0, taxableSubtotalCents - discountCents);
  const taxCents = applyBps(effectiveTaxableAmount, taxRateBps);
  // Processing fee passes card/ACH costs through on the amount actually charged
  // (subtotal − discount + tax), so it compounds nothing and never goes
  // negative even under a total-clearing discount.
  const chargeableBeforeFeeCents = Math.max(0, subtotalCents - discountCents + taxCents);
  const processingFeeCents = applyBps(chargeableBeforeFeeCents, processingFeeBps);
  const totalCents = subtotalCents - discountCents + taxCents + processingFeeCents;

  return {
    subtotalCents,
    discountCents,
    taxRateBps,
    taxableSubtotalCents,
    taxCents,
    processingFeeBps,
    processingFeeCents,
    totalCents: Math.max(0, totalCents),
  };
}

/**
 * True when an estimate carries any customer-selectable line items
 * (tier options or optional add-ons). Used to decide whether the
 * approval flow needs a selection at all.
 */
export function hasSelectableLineItems(lineItems: LineItem[]): boolean {
  return lineItems.some((li) => li.isOptional || li.groupKey);
}

/**
 * Resolve which line items are actually billed given a customer's
 * selection. Always-included items (not optional, no group) are kept
 * unconditionally. Optional items (add-ons and tier options) are kept
 * only when their id is in `selectedIds`. When `selectedIds` is
 * undefined, the default selection is used (`isDefaultSelected` items).
 */
export function resolveSelectedLineItems(
  lineItems: LineItem[],
  selectedIds?: string[],
): LineItem[] {
  const selectable = (li: LineItem) => Boolean(li.isOptional || li.groupKey);
  if (selectedIds === undefined) {
    // Default selection: always-included items, each tier group's default
    // (or its first option by sortOrder when none is flagged, so a group is
    // never silently dropped from the total), and any pre-checked add-ons.
    const result: LineItem[] = [];
    const groups = new Map<string, LineItem[]>();
    for (const li of lineItems) {
      if (li.groupKey) {
        const arr = groups.get(li.groupKey) ?? [];
        arr.push(li);
        groups.set(li.groupKey, arr);
      } else if (li.isOptional) {
        if (li.isDefaultSelected) result.push(li);
      } else {
        result.push(li);
      }
    }
    for (const items of groups.values()) {
      const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
      const chosen = sorted.find((i) => i.isDefaultSelected) ?? sorted[0];
      if (chosen) result.push(chosen);
    }
    return result;
  }
  const chosen = new Set(selectedIds);
  return lineItems.filter((li) => !selectable(li) || chosen.has(li.id));
}

/**
 * The default selection ids (one per tier group + pre-checked add-ons +
 * always-included). Used by the UI to seed its initial selection so the
 * client preview matches the server's default resolution.
 */
export function defaultSelectionIds(lineItems: LineItem[]): string[] {
  return resolveSelectedLineItems(lineItems).map((li) => li.id);
}

/**
 * EE-1 — headline document totals for an ESTIMATE that may carry
 * good-better-best tiers / optional add-ons. Totals the DEFAULT selection
 * (each group's default tier + pre-checked add-ons + always-billed lines)
 * rather than the sum of every option. Identical to `calculateDocumentTotals`
 * for a flat document (no selectable lines → all items selected). Use this at
 * EVERY estimate headline-total site (create / update / revise / duplicate /
 * voice-edit) so a tiered estimate stays consistent — computing raw
 * `calculateDocumentTotals` over all lines re-inflates the headline. The
 * accept path stays separate: it resolves the customer's chosen selection, not
 * the default.
 */
export function calculateSelectedDocumentTotals(
  lineItems: LineItem[],
  discountCents: number,
  taxRateBps: number,
  processingFeeBps: number = 0,
): DocumentTotals {
  return calculateDocumentTotals(
    resolveSelectedLineItems(lineItems),
    discountCents,
    taxRateBps,
    processingFeeBps,
  );
}

/**
 * Validate a customer selection against the estimate's line items.
 * Enforces: every selected id exists; each tier group (group_key) has
 * exactly one selected option. Returns a list of human-readable errors
 * (empty when valid).
 */
export function validateLineItemSelection(
  lineItems: LineItem[],
  selectedIds: string[],
): string[] {
  const errors: string[] = [];
  const byId = new Map(lineItems.map((li) => [li.id, li]));
  const chosen = new Set(selectedIds);

  for (const id of selectedIds) {
    if (!byId.has(id)) errors.push(`Unknown line item selected: ${id}`);
  }

  // Each tier group must have exactly one selected option.
  const groups = new Map<string, LineItem[]>();
  for (const li of lineItems) {
    if (li.groupKey) {
      const list = groups.get(li.groupKey) ?? [];
      list.push(li);
      groups.set(li.groupKey, list);
    }
  }
  for (const [groupKey, items] of groups) {
    const selectedInGroup = items.filter((li) => chosen.has(li.id));
    if (selectedInGroup.length !== 1) {
      const label = items[0]?.groupLabel ?? groupKey;
      errors.push(`Select exactly one option for "${label}"`);
    }
  }

  return errors;
}

export function validateLineItem(item: Partial<LineItem>): string[] {
  const errors: string[] = [];
  if (!item.description) errors.push('description is required');
  if (item.quantity === undefined || item.quantity === null) {
    errors.push('quantity is required');
  } else if (item.quantity < 0) {
    errors.push('quantity must be non-negative');
  }
  if (item.unitPriceCents === undefined || item.unitPriceCents === null) {
    errors.push('unitPriceCents is required');
  } else if (!Number.isInteger(item.unitPriceCents)) {
    errors.push('unitPriceCents must be an integer');
  } else if (item.unitPriceCents < 0) {
    errors.push('unitPriceCents must be non-negative');
  }
  if (item.category && !['labor', 'material', 'equipment', 'other'].includes(item.category)) {
    errors.push('Invalid category');
  }
  return errors;
}

export function validateDocumentTotals(totals: DocumentTotals): string[] {
  const errors: string[] = [];
  if (totals.discountCents < 0) errors.push('discountCents must be non-negative');
  if (totals.taxRateBps < 0) errors.push('taxRateBps must be non-negative');
  if (totals.taxRateBps > 10000) errors.push('taxRateBps must not exceed 10000 (100%)');
  if ((totals.processingFeeBps ?? 0) < 0) errors.push('processingFeeBps must be non-negative');
  if ((totals.processingFeeBps ?? 0) > 10000) {
    errors.push('processingFeeBps must not exceed 10000 (100%)');
  }
  return errors;
}

export function buildLineItem(
  id: string,
  description: string,
  quantity: number,
  unitPriceCents: number,
  sortOrder: number,
  taxable: boolean = true,
  category?: LineItemCategory
): LineItem {
  return {
    id,
    description,
    category,
    quantity,
    unitPriceCents,
    totalCents: calculateLineItemTotal(quantity, unitPriceCents),
    sortOrder,
    taxable,
  };
}
