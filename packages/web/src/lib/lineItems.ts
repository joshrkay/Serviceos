/** UI line item shape used across estimates/invoices pages. */
export interface UiLineItem {
  description: string;
  qty: number;
  rate: number;
}

export type ApiLineItemCategory = 'labor' | 'material' | 'equipment' | 'other';

export interface ApiLineItemPayload {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
  category?: ApiLineItemCategory;
}

function newLineItemId(sortOrder: number): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `li-${crypto.randomUUID()}`;
  }
  return `li-${Date.now()}-${sortOrder}`;
}

/**
 * Maps owner UI line items (dollar rates) to API payloads (integer cents).
 * Used for POST /api/invoices and PUT /api/estimates.
 */
export function uiLineItemsToApiPayload(
  lines: UiLineItem[],
  category: ApiLineItemCategory = 'labor',
): ApiLineItemPayload[] {
  return lines.map((item, sortOrder) => {
    const unitPriceCents = Math.round(item.rate * 100);
    const totalCents = Math.round(item.qty * item.rate * 100);
    return {
      id: newLineItemId(sortOrder),
      description: item.description,
      quantity: item.qty,
      unitPriceCents,
      totalCents,
      sortOrder,
      taxable: false,
      category,
    };
  });
}
