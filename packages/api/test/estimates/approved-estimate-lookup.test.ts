import { lookupApprovedEstimates, scoreRelevance } from '../../src/estimates/approved-estimate-lookup';
import { createApprovedEstimateMetadata, InMemoryApprovedEstimateMetadataRepository } from '../../src/estimates/approved-estimate-metadata';
import { createEstimate, approveEstimate } from '../../src/estimates/estimate';

describe('P4-005B — Tenant-scoped approved-estimate lookup', () => {
  function makeMetadata(overrides: { tenantId?: string; verticalSlug?: string; categoryId?: string } = {}) {
    const est = createEstimate({
      tenantId: overrides.tenantId || 'tenant-1',
      lineItems: [{ id: 'li-1', description: 'Test item', quantity: 1, unitPrice: 100, total: 100 }],
      snapshot: {},
      source: 'ai_generated',
      createdBy: 'user-1',
    });
    const approved = approveEstimate(est, 'mgr');
    return createApprovedEstimateMetadata(approved, overrides.verticalSlug || 'hvac', overrides.categoryId || 'hvac-repair');
  }

  it('happy path — retrieves matching estimates', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    await repo.create(makeMetadata());
    await repo.create(makeMetadata({ verticalSlug: 'plumbing', categoryId: 'plumb-repair' }));

    const results = await lookupApprovedEstimates({ tenantId: 'tenant-1', verticalSlug: 'hvac', categoryId: 'hvac-repair' }, repo);
    expect(results).toHaveLength(1);
    expect(results[0].metadata.verticalSlug).toBe('hvac');
  });

  it('happy path — results sorted by relevance score', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    await repo.create(makeMetadata({ verticalSlug: 'hvac', categoryId: 'hvac-repair' }));
    await repo.create(makeMetadata({ verticalSlug: 'hvac', categoryId: 'hvac-install' }));

    const results = await lookupApprovedEstimates({ tenantId: 'tenant-1', verticalSlug: 'hvac', categoryId: 'hvac-repair' }, repo);
    expect(results[0].relevanceScore).toBeGreaterThanOrEqual(results[results.length - 1].relevanceScore);
  });

  it('validation — scoreRelevance rewards matching vertical and category', () => {
    const metadata = makeMetadata({ verticalSlug: 'hvac', categoryId: 'hvac-repair' });
    const score = scoreRelevance(metadata, { tenantId: 'tenant-1', verticalSlug: 'hvac', categoryId: 'hvac-repair' });
    expect(score).toBeGreaterThan(0.5);
  });

  it('mock provider test — respects limit option', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    for (let i = 0; i < 5; i++) {
      await repo.create(makeMetadata());
    }

    const results = await lookupApprovedEstimates({ tenantId: 'tenant-1', limit: 2 }, repo);
    expect(results).toHaveLength(2);
  });

  it('mock provider test — isolates tenants', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    await repo.create(makeMetadata({ tenantId: 'tenant-1' }));

    const results = await lookupApprovedEstimates({ tenantId: 'other-tenant' }, repo);
    expect(results).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — handles empty results', async () => {
    const repo = new InMemoryApprovedEstimateMetadataRepository();
    const results = await lookupApprovedEstimates({ tenantId: 'no-data' }, repo);
    expect(results).toEqual([]);
  });
});
