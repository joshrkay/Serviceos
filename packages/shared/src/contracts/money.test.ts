import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LineItemCategory } from '../enums.js';
import { lineItemSchema, documentTotalsSchema, lineItemCategorySchema, formatUsdCents } from './money.js';
import { resolveDbCheckSet } from './db-check.js';

const schemaSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src/db/schema.ts'),
  'utf8',
);

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

  it('constrains category to the line-item category set', () => {
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: 'labor' }).success).toBe(true);
    // 'subcontractor' is in the broader shared enum but NOT a persisted line-item category.
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: 'subcontractor' }).success).toBe(false);
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: 'overhead' }).success).toBe(false);
  });

  it('accepts a null category (persisted rows serialize the nullable column as null)', () => {
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: null }).success).toBe(true);
    expect(lineItemSchema.safeParse({ ...baseLineItem, category: undefined }).success).toBe(true);
  });

  it('lineItemCategorySchema matches the LineItemCategory enum and the DB CHECK', () => {
    expect([...lineItemCategorySchema.options].sort()).toEqual([...Object.values(LineItemCategory)].sort());
    const dbSet = resolveDbCheckSet(schemaSource, 'estimate_line_items', 'category');
    expect([...lineItemCategorySchema.options].sort()).toEqual([...dbSet].sort());
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

describe('formatUsdCents', () => {
  it('formats whole dollars without cents, with thousands separators', () => {
    expect(formatUsdCents(0)).toBe('$0');
    expect(formatUsdCents(2500)).toBe('$25');
    expect(formatUsdCents(250000)).toBe('$2,500');
    expect(formatUsdCents(123456700)).toBe('$1,234,567');
  });

  it('formats partial dollars with two-digit cents', () => {
    expect(formatUsdCents(2550)).toBe('$25.50');
    expect(formatUsdCents(2505)).toBe('$25.05');
    expect(formatUsdCents(125050)).toBe('$1,250.50');
  });

  it('handles negatives without float drift', () => {
    expect(formatUsdCents(-2550)).toBe('-$25.50');
  });
});
