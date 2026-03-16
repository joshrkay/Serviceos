import {
  calculateAccelerationMetrics,
  createAccelerationBenchmark,
  calculateApprovalRate,
  calculateAvgEditDistance,
  calculateQualityTrend,
  InMemoryAccelerationBenchmarkRepository,
} from '../../../src/ai/evaluation/acceleration-benchmark';
import { Estimate, InMemoryEstimateRepository, createEstimate } from '../../../src/estimates/estimate';
import { buildLineItem } from '../../../src/shared/billing-engine';
import { VerticalQualityMetric } from '../../../src/ai/evaluation/vertical-quality-metrics';

describe('P4-012 — Estimate-acceleration beta benchmark', () => {
  async function makeEstimates(): Promise<Estimate[]> {
    const repo = new InMemoryEstimateRepository();
    const lineItems = [buildLineItem('li-1', 'Test item', 1, 10000, 1, true)];
    const e1 = await createEstimate({ tenantId: 't', jobId: 'j1', estimateNumber: 'E-001', lineItems, createdBy: 'u' }, repo);
    const e2 = await createEstimate({ tenantId: 't', jobId: 'j2', estimateNumber: 'E-002', lineItems, createdBy: 'u' }, repo);
    const e3 = await createEstimate({ tenantId: 't', jobId: 'j3', estimateNumber: 'E-003', lineItems, createdBy: 'u' }, repo);
    // Transition e1 and e3 to accepted
    await repo.update('t', e1.id, { status: 'ready_for_review' });
    await repo.update('t', e1.id, { status: 'sent' });
    await repo.update('t', e1.id, { status: 'accepted' });
    await repo.update('t', e3.id, { status: 'ready_for_review' });
    await repo.update('t', e3.id, { status: 'sent' });
    await repo.update('t', e3.id, { status: 'accepted' });
    const all = await repo.findByTenant('t');
    return all;
  }

  it('happy path — calculates acceleration metrics', async () => {
    const estimates = await makeEstimates();
    const metrics = calculateAccelerationMetrics(estimates, []);
    expect(metrics.estimatesGenerated).toBe(3);
    expect(metrics.estimatesApproved).toBe(2);
    expect(metrics.approvalRate).toBeCloseTo(2 / 3);
  });

  it('happy path — creates benchmark', () => {
    const benchmark = createAccelerationBenchmark('tenant-1', 'hvac', new Date('2024-01-01'), new Date('2024-01-31'), {
      estimatesGenerated: 10, estimatesApproved: 8, approvalRate: 0.8, avgEditDistance: 0.2, qualityScoreAvg: 0.85, qualityScoreTrend: 0.05,
    });
    expect(benchmark.id).toBeTruthy();
    expect(benchmark.verticalSlug).toBe('hvac');
    expect(benchmark.metrics.approvalRate).toBe(0.8);
  });

  it('validation — calculateApprovalRate handles empty', () => {
    expect(calculateApprovalRate([])).toBe(0);
  });

  it('mock provider test — calculateQualityTrend detects improvement', () => {
    const metrics: VerticalQualityMetric[] = [
      { id: '1', tenantId: 't', estimateId: 'e1', metricType: 'q', score: 0.5, evaluatedAt: new Date('2024-01-01'), verticalType: 'hvac' },
      { id: '2', tenantId: 't', estimateId: 'e2', metricType: 'q', score: 0.6, evaluatedAt: new Date('2024-01-15'), verticalType: 'hvac' },
      { id: '3', tenantId: 't', estimateId: 'e3', metricType: 'q', score: 0.8, evaluatedAt: new Date('2024-02-01'), verticalType: 'hvac' },
      { id: '4', tenantId: 't', estimateId: 'e4', metricType: 'q', score: 0.9, evaluatedAt: new Date('2024-02-15'), verticalType: 'hvac' },
    ];
    const trend = calculateQualityTrend(metrics);
    expect(trend).toBeGreaterThan(0);
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryAccelerationBenchmarkRepository();
    const benchmark = createAccelerationBenchmark('tenant-1', 'hvac', new Date(), new Date(), {
      estimatesGenerated: 10, estimatesApproved: 8, approvalRate: 0.8, avgEditDistance: 0.2, qualityScoreAvg: 0.85, qualityScoreTrend: 0.05,
    });
    await repo.create(benchmark);

    const found = await repo.findByVertical('tenant-1', 'hvac');
    expect(found).toHaveLength(1);
  });

  it('malformed AI output handled gracefully — zero estimates', () => {
    const metrics = calculateAccelerationMetrics([], []);
    expect(metrics.estimatesGenerated).toBe(0);
    expect(metrics.approvalRate).toBe(0);
    expect(metrics.avgEditDistance).toBe(0);
  });
});
