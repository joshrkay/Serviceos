import { createEstimateSummary, summarizeLineItems, extractKeyTerms, InMemoryEstimateSummaryRepository } from '../../src/estimates/estimate-summary';
import { createEstimate } from '../../src/estimates/estimate';

describe('P4-005C — Retrieval-ready estimate summary snapshots', () => {
  function makeEstimate() {
    return createEstimate({
      tenantId: 'tenant-1',
      lineItems: [
        { id: 'li-1', description: 'Capacitor replacement', quantity: 1, unitPrice: 250, total: 250, category: 'parts' },
        { id: 'li-2', description: 'Labor for repair', quantity: 2, unitPrice: 95, total: 190, category: 'labor' },
      ],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'user-1',
    });
  }

  it('happy path — creates summary with all fields', () => {
    const summary = createEstimateSummary(makeEstimate(), 'hvac', 'hvac-repair');
    expect(summary.id).toBeTruthy();
    expect(summary.totalAmount).toBe(440);
    expect(summary.lineItemSummaries).toHaveLength(2);
    expect(summary.summaryText).toContain('hvac');
    expect(summary.summaryText).toContain('2 line items');
  });

  it('happy path — extractKeyTerms extracts meaningful words', () => {
    const terms = extractKeyTerms([
      { id: '1', description: 'Capacitor replacement', quantity: 1, unitPrice: 250, total: 250, category: 'parts' },
    ]);
    expect(terms).toContain('capacitor');
    expect(terms).toContain('replacement');
    expect(terms).toContain('parts');
  });

  it('validation — summarizeLineItems maps correctly', () => {
    const summaries = summarizeLineItems([
      { id: '1', description: 'Test', quantity: 2, unitPrice: 50, total: 100, category: 'labor' },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].description).toBe('Test');
    expect(summaries[0].quantity).toBe(2);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateSummaryRepository();
    const summary = createEstimateSummary(makeEstimate(), 'hvac', 'hvac-repair');
    await repo.create(summary);

    const found = await repo.findByEstimate('tenant-1', summary.estimateId);
    expect(found).not.toBeNull();
  });

  it('mock provider test — findByTenantAndVertical filters correctly', async () => {
    const repo = new InMemoryEstimateSummaryRepository();
    const s1 = createEstimateSummary(makeEstimate(), 'hvac', 'hvac-repair');
    const est2 = createEstimate({ tenantId: 'tenant-1', lineItems: [], snapshot: {}, source: 'manual', createdBy: 'u' });
    const s2 = createEstimateSummary(est2, 'plumbing', 'plumb-repair');
    await repo.create(s1);
    await repo.create(s2);

    const found = await repo.findByTenantAndVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('malformed AI output handled gracefully — handles empty line items', () => {
    const est = createEstimate({ tenantId: 't', lineItems: [], snapshot: {}, source: 'manual', createdBy: 'u' });
    const summary = createEstimateSummary(est, 'hvac', 'hvac-repair');
    expect(summary.totalAmount).toBe(0);
    expect(summary.lineItemSummaries).toEqual([]);
    expect(summary.keyTerms).toEqual([]);
  });
});
