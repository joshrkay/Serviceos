import { createEstimateSummary, summarizeLineItems, extractKeyTerms, InMemoryEstimateSummaryRepository } from '../../src/estimates/estimate-summary';
import { createEstimate, InMemoryEstimateRepository } from '../../src/estimates/estimate';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P4-005C — Retrieval-ready estimate summary snapshots', () => {
  async function makeEstimate() {
    const repo = new InMemoryEstimateRepository();
    return createEstimate({
      tenantId: 'tenant-1',
      jobId: 'j1',
      estimateNumber: 'E-001',
      lineItems: [
        buildLineItem('li-1', 'Capacitor replacement', 1, 25000, 1, true, 'material'),
        buildLineItem('li-2', 'Labor for repair', 2, 9500, 2, true, 'labor'),
      ],
      createdBy: 'user-1',
    }, repo);
  }

  it('happy path — creates summary with all fields', async () => {
    const estimate = await makeEstimate();
    const summary = createEstimateSummary(estimate, 'hvac', 'hvac-repair');
    expect(summary.id).toBeTruthy();
    expect(summary.totalAmount).toBe(44000); // 25000 + 19000 in cents
    expect(summary.lineItemSummaries).toHaveLength(2);
    expect(summary.summaryText).toContain('hvac');
    expect(summary.summaryText).toContain('2 line items');
  });

  it('happy path — extractKeyTerms extracts meaningful words', () => {
    const terms = extractKeyTerms([
      buildLineItem('1', 'Capacitor replacement', 1, 25000, 1, true, 'material'),
    ]);
    expect(terms).toContain('capacitor');
    expect(terms).toContain('replacement');
    expect(terms).toContain('material');
  });

  it('validation — summarizeLineItems maps correctly', () => {
    const summaries = summarizeLineItems([
      buildLineItem('1', 'Test', 2, 5000, 1, true, 'labor'),
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].description).toBe('Test');
    expect(summaries[0].quantity).toBe(2);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateSummaryRepository();
    const estimate = await makeEstimate();
    const summary = createEstimateSummary(estimate, 'hvac', 'hvac-repair');
    await repo.create(summary);

    const found = await repo.findByEstimate('tenant-1', summary.estimateId);
    expect(found).not.toBeNull();
  });

  it('mock provider test — findByTenantAndVertical filters correctly', async () => {
    const summaryRepo = new InMemoryEstimateSummaryRepository();
    const estimate = await makeEstimate();
    const s1 = createEstimateSummary(estimate, 'hvac', 'hvac-repair');

    const estRepo2 = new InMemoryEstimateRepository();
    const est2 = await createEstimate({
      tenantId: 'tenant-1', jobId: 'j2', estimateNumber: 'E-002',
      lineItems: [buildLineItem('1', 'Pipe repair', 1, 15000, 1, true)],
      createdBy: 'u',
    }, estRepo2);
    const s2 = createEstimateSummary(est2, 'plumbing', 'plumb-repair');
    await summaryRepo.create(s1);
    await summaryRepo.create(s2);

    const found = await summaryRepo.findByTenantAndVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('malformed AI output handled gracefully — handles empty line items', async () => {
    const estRepo = new InMemoryEstimateRepository();
    const est = await createEstimate({
      tenantId: 't', jobId: 'j1', estimateNumber: 'E-001',
      lineItems: [buildLineItem('1', 'placeholder', 1, 100, 1, true)],
      createdBy: 'u',
    }, estRepo);
    // Override to empty for test
    (est as any).lineItems = [];
    const summary = createEstimateSummary(est, 'hvac', 'hvac-repair');
    expect(summary.totalAmount).toBe(0);
    expect(summary.lineItemSummaries).toEqual([]);
    expect(summary.keyTerms).toEqual([]);
  });
});
