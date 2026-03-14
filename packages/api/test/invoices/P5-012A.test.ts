import { computeInvoiceQualityMetrics } from '../../src/invoices/analytics';

describe('P5-012A — Invoice quality metrics', () => {
  it('empty outcomes returns zeros', () => {
    const result = computeInvoiceQualityMetrics([], []);
    expect(result.approvalRate).toBe(0);
    expect(result.rejectionRate).toBe(0);
    expect(result.approvedWithEditsRate).toBe(0);
    expect(result.editRate).toBe(0);
    expect(result.averageRevisions).toBe(0);
    expect(result.commonCorrections).toEqual([]);
  });

  it('all approved — approvalRate=1, rejectionRate=0', () => {
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, []);
    expect(result.approvalRate).toBe(1);
    expect(result.rejectionRate).toBe(0);
  });

  it('mixed outcomes calculated correctly', () => {
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'rejected', approvedWithEdits: false },
      { status: 'approved_with_edits', approvedWithEdits: true },
      { status: 'approved', approvedWithEdits: false },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, []);
    expect(result.approvalRate).toBe(3 / 4); // approved + approved_with_edits
    expect(result.rejectionRate).toBe(1 / 4);
  });

  it('with edits — approvedWithEditsRate > 0', () => {
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved_with_edits', approvedWithEdits: true },
      { status: 'approved_with_edits', approvedWithEdits: true },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, []);
    expect(result.approvedWithEditsRate).toBeCloseTo(2 / 3);
  });

  it('common corrections sorted by frequency', () => {
    const deltas = [
      { deltas: [
        { type: 'price_changed', field: 'unitPriceCents', oldValue: 100, newValue: 200 },
        { type: 'quantity_changed', field: 'quantity', oldValue: 1, newValue: 2 },
      ] },
      { deltas: [
        { type: 'price_changed', field: 'unitPriceCents', oldValue: 300, newValue: 400 },
      ] },
      { deltas: [
        { type: 'description_changed', field: 'description', oldValue: 'a', newValue: 'b' },
      ] },
    ];
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, deltas);
    expect(result.commonCorrections[0].field).toBe('unitPriceCents');
    expect(result.commonCorrections[0].frequency).toBe(2);
  });

  it('average delta calculated for numeric fields', () => {
    const deltas = [
      { deltas: [
        { type: 'price_changed', field: 'unitPriceCents', oldValue: 100, newValue: 200 },
      ] },
      { deltas: [
        { type: 'price_changed', field: 'unitPriceCents', oldValue: 300, newValue: 500 },
      ] },
    ];
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, deltas);
    const priceCorrection = result.commonCorrections.find((c) => c.field === 'unitPriceCents');
    expect(priceCorrection).toBeDefined();
    // (|200-100| + |500-300|) / 2 = (100 + 200) / 2 = 150
    expect(priceCorrection!.averageDelta).toBe(150);
  });

  it('edit rate calculated from deltas', () => {
    const outcomes = [
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
      { status: 'approved', approvedWithEdits: false },
    ];
    const deltas = [
      { deltas: [{ type: 'price_changed', field: 'unitPriceCents' }] },
      { deltas: [] },
      { deltas: [{ type: 'quantity_changed', field: 'quantity' }] },
    ];
    const result = computeInvoiceQualityMetrics(outcomes, deltas);
    expect(result.editRate).toBeCloseTo(2 / 3);
  });
});
