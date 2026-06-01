import { describe, expect, it } from 'vitest';
import { lineItemSchema, documentTotalsSchema } from './money.js';

const baseLineItem = {
  id: 'li-1',
  description: 'Diagnostic labor',
  quantity: 1.5,
  unitPriceCents: 12000,
  totalCents: 18000,
  sortOrder: 0,
  taxable: true,
};

describe('lineItemSchema', () => {
  it('parses a representative line item with fractional quantity', () => {
    expect(lineItemSchema.parse(baseLineItem).totalCents).toBe(18000);
  });

  it('keeps cent amounts integer', () => {
    expect(lineItemSchema.safeParse({ ...baseLineItem, unitPriceCents: 120.5 }).success).toBe(false);
  });

  it('constrains category to the shared LineItemCategory set', () => {
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: 'labor' }).success).toBe(true);
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: 'overhead' }).success).toBe(false);
  });
});

describe('documentTotalsSchema', () => {
  it('parses an integer-cents / basis-points totals block', () => {
    const totals = documentTotalsSchema.parse({
      subtotalCents: 18000,
      discountCents: 0,
      taxRateBps: 875,
      taxableSubtotalCents: 18000,
      taxCents: 1575,
      totalCents: 19575,
    });
    expect(totals.taxRateBps).toBe(875);
  });

  it('rejects fractional cents', () => {
    expect(
      documentTotalsSchema.safeParse({
        subtotalCents: 180.25,
        discountCents: 0,
        taxRateBps: 875,
        taxableSubtotalCents: 18000,
        taxCents: 1575,
        totalCents: 19575,
      }).success,
    ).toBe(false);
  });
});
