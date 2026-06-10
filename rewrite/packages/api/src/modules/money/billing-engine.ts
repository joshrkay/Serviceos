import type { DocumentTotals, LineItemInput } from '@rivet/contracts';

/**
 * The shared billing engine: the only place money math happens.
 *
 * Invariants (property-tested in test/billing-engine.property.test.ts):
 * - every intermediate and final value is a non-negative safe integer
 * - lineAmount = round(quantityHundredths * unitPriceCents / 100)
 * - subtotal = sum of line amounts; tax = round(subtotal * bps / 10000)
 * - total = subtotal + tax; totals are permutation-invariant
 */

export interface ComputedLineItem extends LineItemInput {
  amountCents: number;
}

export interface ComputedTotals extends DocumentTotals {
  lineItems: ComputedLineItem[];
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

export function computeLineAmountCents(quantityHundredths: number, unitPriceCents: number): number {
  assertSafeInteger(quantityHundredths, 'quantityHundredths');
  assertSafeInteger(unitPriceCents, 'unitPriceCents');
  const product = quantityHundredths * unitPriceCents;
  assertSafeInteger(product, 'line product');
  return Math.round(product / 100);
}

export function computeTaxCents(subtotalCents: number, taxRateBps: number): number {
  assertSafeInteger(subtotalCents, 'subtotalCents');
  assertSafeInteger(taxRateBps, 'taxRateBps');
  if (taxRateBps > 10_000) throw new RangeError(`taxRateBps must be <= 10000, got ${taxRateBps}`);
  return Math.round((subtotalCents * taxRateBps) / 10_000);
}

export function computeTotals(lineItems: LineItemInput[], taxRateBps: number): ComputedTotals {
  const computed = lineItems.map((item) => ({
    ...item,
    amountCents: computeLineAmountCents(item.quantityHundredths, item.unitPriceCents),
  }));
  const subtotalCents = computed.reduce((sum, item) => sum + item.amountCents, 0);
  assertSafeInteger(subtotalCents, 'subtotalCents');
  const taxCents = computeTaxCents(subtotalCents, taxRateBps);
  const totalCents = subtotalCents + taxCents;
  assertSafeInteger(totalCents, 'totalCents');
  return { lineItems: computed, subtotalCents, taxCents, totalCents, taxRateBps };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
