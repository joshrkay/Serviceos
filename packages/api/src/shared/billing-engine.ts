// Shared billing engine for estimates and invoices
// All money values are integer cents. Tax rate in basis points (bps).

export type LineItemCategory = 'labor' | 'material' | 'equipment' | 'other';

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
  taxRateBps: number
): DocumentTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxableSubtotalCents = lineItems
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.totalCents, 0);

  // Apply discount to taxable amount before computing tax
  const effectiveTaxableAmount = Math.max(0, taxableSubtotalCents - discountCents);
  const taxCents = applyBps(effectiveTaxableAmount, taxRateBps);
  const totalCents = subtotalCents - discountCents + taxCents;

  return {
    subtotalCents,
    discountCents,
    taxRateBps,
    taxableSubtotalCents,
    taxCents,
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
