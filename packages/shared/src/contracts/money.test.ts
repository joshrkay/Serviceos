import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LineItemCategory } from '../enums.js';
import {
  lineItemSchema,
  documentTotalsSchema,
  lineItemCategorySchema,
  catalogUnitSchema,
  formatUsdCents,
  formatUsdCentsFixed,
  formatUsdCentsWhole,
  formatUsdCentsPlain,
  isCentsKey,
  parseMoneyToCents,
  centsToInputValue,
} from './money.js';
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

  // B7.5 — `unit` is descriptive only, so these pin the two things that could
  // silently go wrong: the enum drifting from CatalogUnit, and the field
  // leaking into money math.
  it('catalogUnitSchema stays in lockstep with the API CatalogUnit union', () => {
    // CatalogUnit is a type-only union in packages/api, so it cannot be
    // reflected at runtime — read its literals from the source of truth
    // instead, the same technique resolveDbCheckSet uses for the DB CHECK.
    const catalogSource = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src/catalog/catalog-item.ts'),
      'utf8',
    );
    const match = catalogSource.match(/export type CatalogUnit\s*=\s*([^;]+);/);
    expect(match).not.toBeNull();
    const declared = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...catalogUnitSchema.options].sort()).toEqual([...declared].sort());
  });

  it('accepts a line with a unit, and a unit never changes the money fields', () => {
    const withUnit = lineItemSchema.parse({ ...baseLineItem, unit: 'hour' });
    const withoutUnit = lineItemSchema.parse(baseLineItem);
    expect(withUnit.unit).toBe('hour');
    // Same money, unit or no unit.
    expect(withUnit.quantity).toBe(withoutUnit.quantity);
    expect(withUnit.unitPriceCents).toBe(withoutUnit.unitPriceCents);
    expect(withUnit.totalCents).toBe(withoutUnit.totalCents);
    // Legacy/absent rows still parse.
    expect(lineItemSchema.safeParse({ ...baseLineItem, unit: null }).success).toBe(true);
    expect(lineItemSchema.safeParse({ ...baseLineItem, unit: undefined }).success).toBe(true);
    // An invented unit is refused — this enum is the validation boundary,
    // since the DB column deliberately carries no CHECK.
    expect(lineItemSchema.safeParse({ ...baseLineItem, unit: 'furlong' }).success).toBe(false);
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

describe('formatUsdCentsFixed', () => {
  it('always keeps two-digit cents with thousands separators', () => {
    expect(formatUsdCentsFixed(0)).toBe('$0.00');
    expect(formatUsdCentsFixed(5000)).toBe('$50.00');
    expect(formatUsdCentsFixed(123450)).toBe('$1,234.50');
    expect(formatUsdCentsFixed(2505)).toBe('$25.05');
  });

  it('places the sign before the symbol for negatives', () => {
    expect(formatUsdCentsFixed(-500)).toBe('-$5.00');
    expect(formatUsdCentsFixed(-125050)).toBe('-$1,250.50');
  });
});

describe('formatUsdCentsWhole', () => {
  it('rounds to whole dollars with thousands separators and no cents', () => {
    expect(formatUsdCentsWhole(0)).toBe('$0');
    expect(formatUsdCentsWhole(125000)).toBe('$1,250');
    expect(formatUsdCentsWhole(125050)).toBe('$1,251');
    expect(formatUsdCentsWhole(125049)).toBe('$1,250');
  });

  it('handles negatives', () => {
    expect(formatUsdCentsWhole(-125050)).toBe('-$1,251');
  });
});

describe('formatUsdCentsPlain', () => {
  it('emits bare $N.NN with no thousands separators', () => {
    expect(formatUsdCentsPlain(0)).toBe('$0.00');
    expect(formatUsdCentsPlain(123450)).toBe('$1234.50');
    expect(formatUsdCentsPlain(2505)).toBe('$25.05');
  });
});

/**
 * Review J5 — the money-INPUT half (dollars typed by an operator ⇄ integer
 * cents on the wire). Behaviour mirrors packages/mobile's local twins, which
 * this module is the canonical home for.
 */
describe('isCentsKey / parseMoneyToCents / centsToInputValue', () => {
  it('recognises integer-cents payload keys', () => {
    expect(isCentsKey('proposedUnitPriceCents')).toBe(true);
    expect(isCentsKey('amountCents')).toBe(true);
    expect(isCentsKey('quantity')).toBe(false);
    expect(isCentsKey('centsPerMile')).toBe(false);
  });

  it('parses dollar input to integer cents with string math', () => {
    expect(parseMoneyToCents('80')).toBe(8000);
    expect(parseMoneyToCents('123.45')).toBe(12345);
    expect(parseMoneyToCents('123.4')).toBe(12340);
    expect(parseMoneyToCents('$1,299.50')).toBe(129950);
    // The classic float trap: 0.29 * 100 === 28.999999999999996.
    expect(parseMoneyToCents(' 0.29 ')).toBe(29);
    expect(parseMoneyToCents('290000')).toBe(29_000_000);
  });

  it('returns null rather than a wrong number for non-money input', () => {
    expect(parseMoneyToCents('')).toBeNull();
    expect(parseMoneyToCents('two ninety')).toBeNull();
    expect(parseMoneyToCents('1.234')).toBeNull();
    expect(parseMoneyToCents('-5')).toBeNull();
  });

  it('round-trips cents through the input representation', () => {
    for (const cents of [0, 29, 8900, 12345, 29_000_000]) {
      expect(parseMoneyToCents(centsToInputValue(cents))).toBe(cents);
    }
    expect(centsToInputValue(8900)).toBe('89.00');
    expect(centsToInputValue(-500)).toBe('-5.00');
  });
});
