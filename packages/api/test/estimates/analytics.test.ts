import { computeEstimateAnalytics } from '../../src/estimates/analytics';
import { InMemoryApprovalRepository, recordApproval, recordRejection } from '../../src/estimates/approval';
import { InMemoryEditDeltaRepository, createEditDelta } from '../../src/estimates/edit-delta';
import { buildLineItem } from '../../src/shared/billing-engine';

describe('P1-009F — Estimate learning analytics foundation', () => {
  let approvalRepo: InMemoryApprovalRepository;
  let deltaRepo: InMemoryEditDeltaRepository;

  beforeEach(() => {
    approvalRepo = new InMemoryApprovalRepository();
    deltaRepo = new InMemoryEditDeltaRepository();
  });

  it('happy path — computes analytics with sample data', async () => {
    // Create approvals
    await recordApproval({ tenantId: 'tenant-1', estimateId: 'est-1', approvedBy: 'u-1' }, approvalRepo);
    await recordApproval({ tenantId: 'tenant-1', estimateId: 'est-2', approvedBy: 'u-1', approvedWithEdits: true }, approvalRepo);
    await recordRejection({ tenantId: 'tenant-1', estimateId: 'est-3', rejectedBy: 'u-1', rejectionReason: 'Too expensive' }, approvalRepo);

    // Create edit deltas
    await createEditDelta(
      'tenant-1', 'est-2', 'rev-1', 'rev-2',
      { lineItems: [buildLineItem('1', 'Labor', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'Labor', 1, 7500, 1, true)] },
      deltaRepo
    );

    const analytics = await computeEstimateAnalytics(
      'tenant-1', approvalRepo, deltaRepo, ['est-1', 'est-2', 'est-3']
    );

    expect(analytics.totalEstimates).toBe(3);
    expect(analytics.approvalRate).toBeCloseTo(2 / 3);
    expect(analytics.rejectionRate).toBeCloseTo(1 / 3);
    expect(analytics.approvedWithEditsRate).toBeCloseTo(1 / 3);
    expect(analytics.editRate).toBeCloseTo(1 / 3);
    expect(analytics.commonCorrections.length).toBeGreaterThan(0);
  });

  it('happy path — handles empty data', async () => {
    const analytics = await computeEstimateAnalytics(
      'tenant-1', approvalRepo, deltaRepo, []
    );

    expect(analytics.totalEstimates).toBe(0);
    expect(analytics.approvalRate).toBe(0);
    expect(analytics.rejectionRate).toBe(0);
    expect(analytics.commonCorrections).toHaveLength(0);
  });

  it('validation — correction patterns show frequency', async () => {
    // Multiple price changes
    await createEditDelta(
      'tenant-1', 'est-1', 'rev-1', 'rev-2',
      { lineItems: [buildLineItem('1', 'A', 1, 5000, 1, true)] },
      { lineItems: [buildLineItem('1', 'A', 1, 7500, 1, true)] },
      deltaRepo
    );
    await createEditDelta(
      'tenant-1', 'est-2', 'rev-3', 'rev-4',
      { lineItems: [buildLineItem('1', 'B', 1, 3000, 1, true)] },
      { lineItems: [buildLineItem('1', 'B', 1, 4000, 1, true)] },
      deltaRepo
    );

    const analytics = await computeEstimateAnalytics(
      'tenant-1', approvalRepo, deltaRepo, ['est-1', 'est-2']
    );

    const priceCorrection = analytics.commonCorrections.find((c) => c.field === 'unitPriceCents');
    expect(priceCorrection).toBeTruthy();
    expect(priceCorrection!.frequency).toBe(2);
    expect(priceCorrection!.averageDelta).toBeTruthy();
  });
});
