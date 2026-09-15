/**
 * Estimate list responses serialize document money under `totals`, while a
 * few older callers still provide a flat `totalCents`. Keep the compatibility
 * read at the UI boundary and reject malformed values instead of rendering
 * `$NaN` or silently inventing an amount.
 */
export function getEstimateTotalCents(estimate: {
  totals?: { totalCents?: unknown } | null;
  totalCents?: unknown;
}): number | null {
  const value = estimate.totals?.totalCents ?? estimate.totalCents;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** A line's contribution to a preview total: its (already-cents) amount and
 * whether it is taxable. Deliberately narrower than the full LineItem shape
 * so any caller (estimates, invoices) can feed this without importing a
 * page-local type. */
export interface PreviewLine {
  totalCents: number;
  taxable?: boolean;
}

export interface EstimatePreviewTotals {
  subtotalCents: number;
  taxableSubtotalCents: number;
  discountCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Client-side preview of an estimate/invoice document's totals, in integer
 * cents — mirrors `calculateDocumentTotals` in
 * packages/api/src/shared/billing-engine.ts (tax applies to the taxable
 * subtotal net of discount; `Math.round` for cent rounding, half-up for
 * positive amounts, matching the server). Estimates never carry a processing
 * fee, so that term is omitted here (see billing-engine's comment on
 * `processingFeeCents`).
 *
 * Used while an operator is editing line items locally, before the next
 * save/refetch lands the server-authoritative `totals` — see D-7
 * (docs/verification/full-verification-2026-09-06.md): the estimate detail
 * view previously summed `qty * rate` float dollars and ignored tax/discount
 * entirely, showing the untaxed subtotal as the total. All money: integer
 * cents, never floating point (CLAUDE.md).
 */
export function computeEstimatePreviewTotals(
  lineItems: PreviewLine[],
  discountCents: number,
  taxRateBps: number,
): EstimatePreviewTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  const taxableSubtotalCents = lineItems
    .filter((item) => item.taxable)
    .reduce((sum, item) => sum + item.totalCents, 0);
  const effectiveTaxableCents = Math.max(0, taxableSubtotalCents - discountCents);
  const taxCents = Math.round((effectiveTaxableCents * taxRateBps) / 10000);
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  return { subtotalCents, taxableSubtotalCents, discountCents, taxRateBps, taxCents, totalCents };
}
