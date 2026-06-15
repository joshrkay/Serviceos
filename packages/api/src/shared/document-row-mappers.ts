// Row-to-domain mappers shared by the invoice and estimate Pg repositories.
// Invoice and estimate line items / totals have identical column shapes, so
// the mapping lives here rather than being duplicated per repository.

import { LineItem, DocumentTotals } from './billing-engine';

export function mapLineItemRow(row: Record<string, any>): LineItem {
  return {
    id: row.id,
    description: row.description,
    category: row.category,
    quantity: Number(row.quantity),
    unitPriceCents: Number(row.unit_price_cents),
    totalCents: Number(row.total_cents),
    sortOrder: Number(row.sort_order),
    taxable: row.taxable,
    // Good-better-best columns (estimate_line_items only; null on invoices).
    groupKey: row.group_key ?? undefined,
    groupLabel: row.group_label ?? undefined,
    isOptional: row.is_optional ?? undefined,
    isDefaultSelected: row.is_default_selected ?? undefined,
    // Catalog-grounding signal (estimate_line_items only; the column does
    // not exist on invoice_line_items, so row.pricing_source is undefined
    // there → undefined here, leaving invoice lines untouched).
    pricingSource: row.pricing_source ?? undefined,
  };
}

export function mapDocumentTotalsRow(row: Record<string, any>): DocumentTotals {
  return {
    subtotalCents: Number(row.subtotal_cents),
    taxableSubtotalCents: Number(row.taxable_subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxRateBps: Number(row.tax_rate_bps),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
  };
}
