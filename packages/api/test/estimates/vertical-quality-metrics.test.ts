import { computeVerticalQualityMetrics } from '../../src/estimates/vertical-quality-metrics';
import { InMemoryApprovalRepository, recordApproval, recordRejection } from '../../src/estimates/approval';
import { InMemoryEditDeltaRepository } from '../../src/estimates/edit-delta';
import { v4 as uuidv4 } from 'uuid';

describe('P4-011A — Vertical-aware estimate quality metric model', () => {
  let approvalRepo: InMemoryApprovalRepository;
  let deltaRepo: InMemoryEditDeltaRepository;

  beforeEach(async () => {
    approvalRepo = new InMemoryApprovalRepository();
    deltaRepo = new InMemoryEditDeltaRepository();

    // Seed approvals
    await recordApproval({ tenantId: 't1', estimateId: 'est-1', approvedBy: 'u1' }, approvalRepo);
    await recordApproval({ tenantId: 't1', estimateId: 'est-2', approvedBy: 'u1', approvedWithEdits: true }, approvalRepo);
    await recordRejection({ tenantId: 't1', estimateId: 'est-3', rejectedBy: 'u1', rejectionReason: 'Too high' }, approvalRepo);

    // Seed deltas for est-2 (approved with edits)
    await deltaRepo.create({
      id: uuidv4(),
      tenantId: 't1',
      estimateId: 'est-2',
      fromRevisionId: 'r1',
      toRevisionId: 'r2',
      deltas: [
        { type: 'price_changed', lineItemId: 'li-1', field: 'unitPriceCents', oldValue: 5000, newValue: 4500 },
        { type: 'line_item_added', lineItemId: 'li-2', newValue: { description: 'Extra part' } },
      ],
      summary: '1 item(s) added, 1 change(s)',
      createdAt: new Date(),
    });
  });

  it('happy path — computes metrics for vertical', async () => {
    const metrics = await computeVerticalQualityMetrics(
      't1', 'hvac', approvalRepo, deltaRepo,
      ['est-1', 'est-2', 'est-3']
    );

    expect(metrics.tenantId).toBe('t1');
    expect(metrics.verticalType).toBe('hvac');
    expect(metrics.sampleSize).toBe(3);
    expect(metrics.approvalRate).toBeCloseTo(2 / 3);
    expect(metrics.editRate).toBeCloseTo(1 / 3);
    expect(metrics.averageRevisions).toBeCloseTo(1 / 3);
    expect(metrics.commonCorrections.length).toBeGreaterThan(0);
  });

  it('happy path — line item accuracy reflects line-item changes', async () => {
    const metrics = await computeVerticalQualityMetrics(
      't1', 'hvac', approvalRepo, deltaRepo,
      ['est-1', 'est-2', 'est-3']
    );

    // Only est-2 has line-item-level changes, so accuracy = 1 - 1/3
    expect(metrics.lineItemAccuracy).toBeCloseTo(2 / 3);
  });

  it('happy path — empty estimate list returns zero metrics', async () => {
    const metrics = await computeVerticalQualityMetrics(
      't1', 'hvac', approvalRepo, deltaRepo, []
    );

    expect(metrics.sampleSize).toBe(0);
    expect(metrics.approvalRate).toBe(0);
    expect(metrics.lineItemAccuracy).toBe(1);
    expect(metrics.commonCorrections).toHaveLength(0);
  });

  it('happy path — passes through options', async () => {
    const start = new Date('2024-01-01');
    const end = new Date('2024-06-30');
    const metrics = await computeVerticalQualityMetrics(
      't1', 'hvac', approvalRepo, deltaRepo,
      ['est-1'],
      { serviceCategory: 'diagnostic', promptVersion: 'v2', periodStart: start, periodEnd: end }
    );

    expect(metrics.serviceCategory).toBe('diagnostic');
    expect(metrics.promptVersion).toBe('v2');
    expect(metrics.periodStart).toBe(start);
    expect(metrics.periodEnd).toBe(end);
  });

  it('happy path — common corrections sorted by frequency', async () => {
    // Add more deltas with price_changed to increase its frequency
    await deltaRepo.create({
      id: uuidv4(),
      tenantId: 't1',
      estimateId: 'est-1',
      fromRevisionId: 'r1',
      toRevisionId: 'r2',
      deltas: [
        { type: 'price_changed', lineItemId: 'li-3', field: 'unitPriceCents', oldValue: 3000, newValue: 2500 },
        { type: 'price_changed', lineItemId: 'li-4', field: 'unitPriceCents', oldValue: 7000, newValue: 6000 },
      ],
      summary: '2 change(s)',
      createdAt: new Date(),
    });

    const metrics = await computeVerticalQualityMetrics(
      't1', 'hvac', approvalRepo, deltaRepo,
      ['est-1', 'est-2']
    );

    expect(metrics.commonCorrections[0].field).toBe('unitPriceCents');
    expect(metrics.commonCorrections[0].frequency).toBe(3);
    expect(metrics.commonCorrections[0].averageDelta).toBeDefined();
  });
});
