import { describe, expect, it } from 'vitest';
import { computeEstimatePreviewTotals } from './estimateMoney';

// D-7 (docs/verification/full-verification-2026-09-06.md) — the estimate
// detail view summed float dollar rates and ignored tax entirely, showing
// the untaxed subtotal as the total. This function is the integer-cents fix,
// mirroring packages/api/src/shared/billing-engine.ts calculateDocumentTotals.
describe('computeEstimatePreviewTotals', () => {
  it('returns the subtotal as the total when there is no tax or discount', () => {
    const totals = computeEstimatePreviewTotals(
      [{ totalCents: 10000, taxable: true }, { totalCents: 5000, taxable: false }],
      0,
      0,
    );
    expect(totals).toEqual({
      subtotalCents: 15000,
      taxableSubtotalCents: 10000,
      discountCents: 0,
      taxRateBps: 0,
      taxCents: 0,
      totalCents: 15000,
    });
  });

  // Runtime-proven case from the defect: 12900 + 3*4500 + 8900 = 35300,
  // taxRateBps 800 (8%) -> taxCents 2824, totalCents 38124.
  it('computes 8% tax on the taxable subtotal (runtime-proven fixture)', () => {
    const totals = computeEstimatePreviewTotals(
      [
        { totalCents: 12_900, taxable: true },
        { totalCents: 4_500, taxable: true },
        { totalCents: 4_500, taxable: true },
        { totalCents: 4_500, taxable: true },
        { totalCents: 8_900, taxable: true },
      ],
      0,
      800,
    );
    expect(totals.subtotalCents).toBe(35_300);
    expect(totals.taxCents).toBe(2_824);
    expect(totals.totalCents).toBe(38_124);
  });

  it('rounds a half-cent tax up (half-up rounding, matching Math.round)', () => {
    // 125 cents * 1000bps / 10000 = 12.5 cents exactly.
    const totals = computeEstimatePreviewTotals([{ totalCents: 125, taxable: true }], 0, 1000);
    expect(totals.taxCents).toBe(13); // Math.round(12.5) === 13
  });

  it('excludes a non-taxable line from the taxable subtotal and tax', () => {
    const totals = computeEstimatePreviewTotals(
      [
        { totalCents: 10_000, taxable: true },
        { totalCents: 10_000, taxable: false },
      ],
      0,
      1000, // 10%
    );
    expect(totals.subtotalCents).toBe(20_000);
    expect(totals.taxableSubtotalCents).toBe(10_000);
    expect(totals.taxCents).toBe(1_000);
    expect(totals.totalCents).toBe(21_000);
  });

  it('applies the discount to the taxable amount before computing tax, then subtracts it from the total', () => {
    const totals = computeEstimatePreviewTotals(
      [{ totalCents: 10_000, taxable: true }],
      2_000, // $20 discount
      1000, // 10%
    );
    // effective taxable = 10000 - 2000 = 8000; tax = 800
    expect(totals.taxCents).toBe(800);
    // total = 10000 - 2000 + 800 = 8800
    expect(totals.totalCents).toBe(8_800);
  });

  it('treats a line with taxable undefined as non-taxable', () => {
    const totals = computeEstimatePreviewTotals([{ totalCents: 5_000 }], 0, 1000);
    expect(totals.taxableSubtotalCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(5_000);
  });

  it('never returns a negative total even when discount exceeds the subtotal', () => {
    const totals = computeEstimatePreviewTotals(
      [{ totalCents: 1_000, taxable: true }],
      5_000,
      1000,
    );
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });
});
