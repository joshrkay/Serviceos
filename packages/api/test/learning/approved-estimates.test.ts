import {
  buildApprovedEstimateContext,
  computeApprovalStats,
  InMemoryApprovedEstimateRepository,
  ApprovedEstimateContext,
} from '../../src/learning/approved-estimates';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('P4-005 — Approved Estimate Retrieval', () => {
  let repo: InMemoryApprovedEstimateRepository;

  const createSampleEstimate = (overrides: Partial<ApprovedEstimateContext> = {}): ApprovedEstimateContext => ({
    estimateId: 'est-1',
    estimateNumber: 'EST-0001',
    jobId: 'job-1',
    lineItems: [
      { description: 'Labor', category: 'labor', quantity: 2, unitPriceCents: 12500, totalCents: 25000, taxable: true },
      { description: 'Parts', category: 'material', quantity: 1, unitPriceCents: 15000, totalCents: 15000, taxable: true },
    ],
    totals: { subtotalCents: 40000, discountCents: 0, taxCents: 3300, totalCents: 43300 },
    categoryId: 'hvac-repair-ac',
    verticalType: 'hvac',
    wasEditedBeforeApproval: false,
    approvalSource: 'ai_generated',
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    repo = new InMemoryApprovedEstimateRepository();
  });

  it('happy path — retrieves approved estimates by tenant', async () => {
    const est = createSampleEstimate();
    repo.addEstimate(est);

    const results = await repo.findApprovedByTenant({ tenantId: 'tenant-1' });
    expect(results).toHaveLength(1);
    expect(results[0].estimateId).toBe('est-1');
  });

  it('filters by vertical type', async () => {
    repo.addEstimate(createSampleEstimate({ verticalType: 'hvac' }));
    repo.addEstimate(createSampleEstimate({ estimateId: 'est-2', verticalType: 'plumbing' }));

    const results = await repo.findApprovedByTenant({ tenantId: 'tenant-1', verticalType: 'hvac' });
    expect(results).toHaveLength(1);
  });

  it('filters by category', async () => {
    repo.addEstimate(createSampleEstimate({ categoryId: 'hvac-repair-ac' }));
    repo.addEstimate(createSampleEstimate({ estimateId: 'est-2', categoryId: 'hvac-install-ac' }));

    const results = await repo.findApprovedByTenant({ tenantId: 'tenant-1', categoryId: 'hvac-repair-ac' });
    expect(results).toHaveLength(1);
  });

  it('filters by total range', async () => {
    repo.addEstimate(createSampleEstimate({ totals: { subtotalCents: 10000, discountCents: 0, taxCents: 825, totalCents: 10825 } }));
    repo.addEstimate(createSampleEstimate({ estimateId: 'est-2', totals: { subtotalCents: 100000, discountCents: 0, taxCents: 8250, totalCents: 108250 } }));

    const results = await repo.findApprovedByTenant({
      tenantId: 'tenant-1',
      minTotalCents: 5000,
      maxTotalCents: 50000,
    });
    expect(results).toHaveLength(1);
  });

  it('finds similar estimates', async () => {
    repo.addEstimate(createSampleEstimate({
      categoryId: 'hvac-repair-ac',
      totals: { subtotalCents: 40000, discountCents: 0, taxCents: 3300, totalCents: 43300 },
    }));
    repo.addEstimate(createSampleEstimate({
      estimateId: 'est-2',
      categoryId: 'hvac-repair-ac',
      totals: { subtotalCents: 500000, discountCents: 0, taxCents: 41250, totalCents: 541250 },
    }));

    const similar = await repo.findSimilar('tenant-1', 'hvac-repair-ac', { min: 30000, max: 60000 }, 10);
    expect(similar).toHaveLength(1);
  });

  it('builds context from estimate', () => {
    const lineItems = [
      buildLineItem('1', 'Labor', 2, 12500, 1, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 825);

    const context = buildApprovedEstimateContext(
      {
        id: 'est-1',
        tenantId: 'tenant-1',
        jobId: 'job-1',
        estimateNumber: 'EST-0001',
        status: 'accepted',
        lineItems,
        totals,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        categoryId: 'hvac-repair-ac',
        verticalType: 'hvac',
        wasEdited: true,
        editedFields: ['lineItems'],
        approvalSource: 'ai_generated',
      }
    );

    expect(context.wasEditedBeforeApproval).toBe(true);
    expect(context.editedFields).toContain('lineItems');
    expect(context.approvalSource).toBe('ai_generated');
  });

  it('computes approval stats', () => {
    const approved = [
      createSampleEstimate({ wasEditedBeforeApproval: false }),
      createSampleEstimate({ estimateId: 'est-2', wasEditedBeforeApproval: true }),
      createSampleEstimate({ estimateId: 'est-3', wasEditedBeforeApproval: false }),
    ];

    const stats = computeApprovalStats(approved, 1); // 1 rejection
    expect(stats.totalApproved).toBe(3);
    expect(stats.totalRejected).toBe(1);
    expect(stats.approvalRate).toBe(0.75); // 3/4
    expect(stats.cleanApprovalRate).toBe(0.5); // 2/4
    expect(stats.editRate).toBeCloseTo(0.333, 2); // 1/3
    expect(stats.totalApprovedWithEdits).toBe(1);
  });

  it('handles empty data in approval stats', () => {
    const stats = computeApprovalStats([], 0);
    expect(stats.approvalRate).toBe(0);
    expect(stats.cleanApprovalRate).toBe(0);
    expect(stats.editRate).toBe(0);
    expect(stats.averageTotalCents).toBe(0);
  });

  it('computes per-category stats', () => {
    const approved = [
      createSampleEstimate({ categoryId: 'hvac-repair-ac', totals: { subtotalCents: 40000, discountCents: 0, taxCents: 0, totalCents: 40000 } }),
      createSampleEstimate({ estimateId: 'est-2', categoryId: 'hvac-install-ac', totals: { subtotalCents: 200000, discountCents: 0, taxCents: 0, totalCents: 200000 } }),
    ];

    const stats = computeApprovalStats(approved, 0);
    expect(stats.byCategory['hvac-repair-ac'].count).toBe(1);
    expect(stats.byCategory['hvac-repair-ac'].avgTotalCents).toBe(40000);
    expect(stats.byCategory['hvac-install-ac'].count).toBe(1);
  });
});
