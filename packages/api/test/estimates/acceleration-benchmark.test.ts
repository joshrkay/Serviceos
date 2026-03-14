import { computeAccelerationBenchmark, AccelerationBenchmark } from '../../src/estimates/acceleration-benchmark';
import { VerticalEstimateQuality } from '../../src/estimates/vertical-quality-metrics';

describe('P4-012 — Estimate-acceleration beta benchmark', () => {
  const baseMetrics: VerticalEstimateQuality = {
    tenantId: 't1',
    verticalType: 'hvac',
    approvalRate: 0.8,
    editRate: 0.3,
    averageRevisions: 0.5,
    lineItemAccuracy: 0.7,
    commonCorrections: [],
    sampleSize: 10,
    periodStart: new Date('2024-01-01'),
    periodEnd: new Date('2024-06-30'),
  };

  it('happy path — computes benchmark with time savings', () => {
    const benchmark = computeAccelerationBenchmark('t1', 'hvac', baseMetrics, {
      manualEstimateTimeMs: 600000,
      aiAssistedEstimateTimeMs: 180000,
    });

    expect(benchmark.tenantId).toBe('t1');
    expect(benchmark.verticalType).toBe('hvac');
    expect(benchmark.timeSavingsPercent).toBe(70);
    expect(benchmark.sampleSize).toBe(10);
    expect(benchmark.qualityScore).toBeGreaterThan(0);
    expect(benchmark.qualityScore).toBeLessThanOrEqual(1);
  });

  it('happy path — quality score reflects metrics', () => {
    const perfectMetrics: VerticalEstimateQuality = {
      ...baseMetrics,
      approvalRate: 1.0,
      editRate: 0,
      lineItemAccuracy: 1.0,
    };

    const benchmark = computeAccelerationBenchmark('t1', 'hvac', perfectMetrics);
    expect(benchmark.qualityScore).toBe(1);
  });

  it('happy path — no timing data yields undefined savings', () => {
    const benchmark = computeAccelerationBenchmark('t1', 'hvac', baseMetrics);

    expect(benchmark.timeSavingsPercent).toBeUndefined();
    expect(benchmark.manualEstimateTimeMs).toBeUndefined();
    expect(benchmark.aiAssistedEstimateTimeMs).toBeUndefined();
  });

  it('happy path — zero sample size yields zero quality score', () => {
    const emptyMetrics: VerticalEstimateQuality = {
      ...baseMetrics,
      sampleSize: 0,
      approvalRate: 0,
      editRate: 0,
      lineItemAccuracy: 1,
    };

    const benchmark = computeAccelerationBenchmark('t1', 'plumbing', emptyMetrics);
    expect(benchmark.qualityScore).toBe(0);
    expect(benchmark.sampleSize).toBe(0);
  });

  it('happy path — period dates from quality metrics', () => {
    const benchmark = computeAccelerationBenchmark('t1', 'hvac', baseMetrics);

    expect(benchmark.periodStart).toEqual(new Date('2024-01-01'));
    expect(benchmark.periodEnd).toEqual(new Date('2024-06-30'));
  });
});
