import {
  calculateLineItemTotal,
  calculateDocumentTotals,
  validateLineItem,
  validateDocumentTotals,
  buildLineItem,
} from '../../src/shared/billing-engine';

describe('P1-009A — Shared line-item validation + calculation engine', () => {
  it('happy path — calculates line item total', () => {
    expect(calculateLineItemTotal(2, 5000)).toBe(10000); // 2 × $50.00 = $100.00
    expect(calculateLineItemTotal(1, 7500)).toBe(7500);  // 1 × $75.00 = $75.00
  });

  it('happy path — calculates document totals', () => {
    const items = [
      buildLineItem('1', 'Labor', 2, 5000, 1, true, 'labor'),     // $100.00 taxable
      buildLineItem('2', 'Material', 1, 3000, 2, true, 'material'), // $30.00 taxable
      buildLineItem('3', 'Discount item', 1, 2000, 3, false),       // $20.00 non-taxable
    ];

    const totals = calculateDocumentTotals(items, 0, 825); // 8.25% tax

    expect(totals.subtotalCents).toBe(15000);      // $150.00
    expect(totals.taxableSubtotalCents).toBe(13000); // $130.00 (only taxable items)
    expect(totals.taxCents).toBe(1073);              // Math.round(13000 * 825 / 10000)
    expect(totals.totalCents).toBe(16073);           // $150.00 + $10.73
  });

  it('happy path — applies discount before tax', () => {
    const items = [buildLineItem('1', 'Service', 1, 10000, 1, true)]; // $100.00

    const totals = calculateDocumentTotals(items, 2000, 1000); // $20 discount, 10% tax

    expect(totals.subtotalCents).toBe(10000);
    expect(totals.discountCents).toBe(2000);
    // Tax on (10000 - 2000) = 8000 * 10% = 800
    expect(totals.taxCents).toBe(800);
    expect(totals.totalCents).toBe(8800); // 10000 - 2000 + 800
  });

  it('zero amount edge case — zero quantity', () => {
    const items = [buildLineItem('1', 'Zero', 0, 5000, 1, true)];
    const totals = calculateDocumentTotals(items, 0, 825);

    expect(totals.subtotalCents).toBe(0);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  it('zero amount edge case — zero price', () => {
    const items = [buildLineItem('1', 'Free', 1, 0, 1, true)];
    const totals = calculateDocumentTotals(items, 0, 825);

    expect(totals.subtotalCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  it('zero amount edge case — empty line items', () => {
    const totals = calculateDocumentTotals([], 0, 0);
    expect(totals.subtotalCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  it('rounding boundary — fractional quantities', () => {
    // 1.5 hours × $75.00/hr = $112.50
    const total = calculateLineItemTotal(1.5, 7500);
    expect(total).toBe(11250);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('rounding boundary — tax rounding', () => {
    // $33.33 at 8.25% = $2.749725, should round to $2.75 = 275 cents
    const items = [buildLineItem('1', 'Item', 1, 3333, 1, true)];
    const totals = calculateDocumentTotals(items, 0, 825);
    expect(totals.taxCents).toBe(275);
    expect(Number.isInteger(totals.taxCents)).toBe(true);
  });

  it('rounding boundary — discount exceeds taxable amount', () => {
    const items = [buildLineItem('1', 'Item', 1, 1000, 1, true)]; // $10
    const totals = calculateDocumentTotals(items, 2000, 825); // $20 discount on $10

    expect(totals.taxCents).toBe(0); // No tax on negative amount
    expect(totals.totalCents).toBe(0); // Floor at 0
  });

  it('validation — rejects invalid line item', () => {
    const errors = validateLineItem({});
    expect(errors).toContain('description is required');
    expect(errors).toContain('quantity is required');
    expect(errors).toContain('unitPriceCents is required');
  });

  it('validation — rejects negative values', () => {
    const errors = validateLineItem({
      description: 'Test',
      quantity: -1,
      unitPriceCents: -100,
    });
    expect(errors).toContain('quantity must be non-negative');
    expect(errors).toContain('unitPriceCents must be non-negative');
  });

  it('validation — rejects non-integer unitPriceCents', () => {
    const errors = validateLineItem({
      description: 'Test',
      quantity: 1,
      unitPriceCents: 10.5,
    });
    expect(errors).toContain('unitPriceCents must be an integer');
  });

  it('validation — rejects invalid document totals', () => {
    const errors = validateDocumentTotals({
      subtotalCents: 0,
      discountCents: -100,
      taxRateBps: 15000,
      taxableSubtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    });
    expect(errors).toContain('discountCents must be non-negative');
    expect(errors).toContain('taxRateBps must not exceed 10000 (100%)');
  });
});
