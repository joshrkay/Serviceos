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
  const taxCents = Math.round((effectiveTaxableAmount * taxRateBps) / 10000);
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
