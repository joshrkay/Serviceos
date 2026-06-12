import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeLineAmountCents,
  computeTaxCents,
  computeTotals,
} from '../src/modules/money/billing-engine';

const lineItemArb = fc.record({
  description: fc.string({ minLength: 1, maxLength: 100 }),
  quantityHundredths: fc.integer({ min: 1, max: 1_000_000 }),
  unitPriceCents: fc.integer({ min: 0, max: 1_000_000_000 }),
});

const lineItemsArb = fc.array(lineItemArb, { minLength: 1, maxLength: 50 });
const taxRateArb = fc.integer({ min: 0, max: 10_000 });

describe('billing engine properties', () => {
  it('all outputs are non-negative safe integers', () => {
    fc.assert(
      fc.property(lineItemsArb, taxRateArb, (items, taxRateBps) => {
        const totals = computeTotals(items, taxRateBps);
        for (const value of [totals.subtotalCents, totals.taxCents, totals.totalCents]) {
          expect(Number.isSafeInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        for (const item of totals.lineItems) {
          expect(Number.isSafeInteger(item.amountCents)).toBe(true);
          expect(item.amountCents).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it('subtotal is exactly the sum of line amounts and total = subtotal + tax', () => {
    fc.assert(
      fc.property(lineItemsArb, taxRateArb, (items, taxRateBps) => {
        const totals = computeTotals(items, taxRateBps);
        const sum = totals.lineItems.reduce((acc, item) => acc + item.amountCents, 0);
        expect(totals.subtotalCents).toBe(sum);
        expect(totals.totalCents).toBe(totals.subtotalCents + totals.taxCents);
      }),
      { numRuns: 2_000 },
    );
  });

  it('tax never exceeds subtotal (rate is capped at 100%)', () => {
    fc.assert(
      fc.property(lineItemsArb, taxRateArb, (items, taxRateBps) => {
        const totals = computeTotals(items, taxRateBps);
        expect(totals.taxCents).toBeLessThanOrEqual(totals.subtotalCents);
      }),
      { numRuns: 2_000 },
    );
  });

  it('totals are invariant under line item permutation', () => {
    fc.assert(
      fc.property(lineItemsArb, taxRateArb, fc.infiniteStream(fc.nat()), (items, taxRateBps, randoms) => {
        const shuffled = [...items]
          .map((item) => ({ item, key: randoms.next().value }))
          .sort((a, b) => a.key - b.key)
          .map(({ item }) => item);
        const a = computeTotals(items, taxRateBps);
        const b = computeTotals(shuffled, taxRateBps);
        expect(b.subtotalCents).toBe(a.subtotalCents);
        expect(b.taxCents).toBe(a.taxCents);
        expect(b.totalCents).toBe(a.totalCents);
      }),
      { numRuns: 1_000 },
    );
  });

  it('adding a line item never decreases the subtotal', () => {
    fc.assert(
      fc.property(lineItemsArb, lineItemArb, taxRateArb, (items, extra, taxRateBps) => {
        const base = computeTotals(items, taxRateBps);
        const grown = computeTotals([...items, extra], taxRateBps);
        expect(grown.subtotalCents).toBeGreaterThanOrEqual(base.subtotalCents);
      }),
      { numRuns: 1_000 },
    );
  });

  it('line amount is the correctly rounded quantity x price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (quantityHundredths, unitPriceCents) => {
          const amount = computeLineAmountCents(quantityHundredths, unitPriceCents);
          expect(amount).toBe(Math.round((quantityHundredths * unitPriceCents) / 100));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('rejects unsafe inputs instead of silently corrupting money', () => {
    expect(() => computeLineAmountCents(1.5, 100)).toThrow(RangeError);
    expect(() => computeLineAmountCents(-1, 100)).toThrow(RangeError);
    expect(() => computeTaxCents(100, 10_001)).toThrow(RangeError);
    expect(() => computeTaxCents(Number.MAX_SAFE_INTEGER + 1, 100)).toThrow(RangeError);
  });
});
