import {
  createApprovedEstimateMetadata,
  buildSearchableContent,
  validateApprovedEstimateMetadataInput,
  InMemoryApprovedEstimateMetadataRepository,
} from '../../src/estimates/approved-estimate-metadata';
import { createEstimate, approveEstimate } from '../../src/estimates/estimate';

describe('P4-005A — Approved-estimate retrieval metadata', () => {
  function makeApprovedEstimate() {
    const est = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [
        { id: 'li-1', description: 'Capacitor replacement', quantity: 1, unitPrice: 250, total: 250, category: 'parts' },
        { id: 'li-2', description: 'Labor - 2 hours', quantity: 2, unitPrice: 95, total: 190, category: 'labor' },
      ],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'user-1',
    });
    return approveEstimate(est, 'manager-1');
  }

  it('happy path — creates metadata from approved estimate', () => {
    const estimate = makeApprovedEstimate();
    const metadata = createApprovedEstimateMetadata(estimate, 'hvac', 'hvac-repair');

    expect(metadata.id).toBeTruthy();
    expect(metadata.tenantId).toBe('tenant-1');
    expect(metadata.verticalSlug).toBe('hvac');
    expect(metadata.lineItemCount).toBe(2);
    expect(metadata.totalAmount).toBe(440);
    expect(metadata.tags).toContain('parts');
    expect(metadata.tags).toContain('labor');
  });

  it('happy path — buildSearchableContent includes line item descriptions', () => {
    const estimate = makeApprovedEstimate();
    const content = buildSearchableContent(estimate);
    expect(content).toContain('capacitor replacement');
    expect(content).toContain('labor');
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateApprovedEstimateMetadataInput({
      tenantId: '',
      estimateId: '',
      verticalSlug: '',
      categoryId: '',
      approvedAt: new Date(),
      approvedBy: '',
      lineItemCount: 0,
      totalAmount: 0,
      tags: [],
      searchableContent: '',
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('verticalSlug is required');
    expect(errors).toContain('categoryId is required');
    expect(errors).toContain('approvedBy is required');
  });

  it('mock provider test — repository stores and retrieves by vertical', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    const estimate = makeApprovedEstimate();
    const metadata = createApprovedEstimateMetadata(estimate, 'hvac', 'hvac-repair');
    await repo.create(metadata);

    const found = await repo.findByVerticalAndCategory('tenant-1', 'hvac', 'hvac-repair');
    expect(found).toHaveLength(1);
  });

  it('mock provider test — findRecent respects limit', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    for (let i = 0; i < 5; i++) {
      const estimate = makeApprovedEstimate();
      const metadata = createApprovedEstimateMetadata(estimate, 'hvac', 'hvac-repair');
      await repo.create(metadata);
    }

    const found = await repo.findRecent('tenant-1', 3);
    expect(found).toHaveLength(3);
  });

  it('malformed AI output handled gracefully — handles estimate with no line items', () => {
    const estimate = createEstimate({
      tenantId: 'tenant-1',
      lineItems: [],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'user-1',
    });
    const approved = approveEstimate(estimate, 'mgr');
    const metadata = createApprovedEstimateMetadata(approved, 'hvac', 'hvac-repair');
    expect(metadata.lineItemCount).toBe(0);
    expect(metadata.totalAmount).toBe(0);
    expect(metadata.tags).toEqual([]);
  });
});
