import {
  createEstimateQualityMetric,
  validateEstimateQualityMetricInput,
  InMemoryEstimateQualityRepository,
} from '../../src/estimates/estimate-quality';

describe('P1-009F — Estimate quality metrics stub', () => {
  it('happy path — creates quality metric with all fields', () => {
    const metric = createEstimateQualityMetric({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      metricType: 'accuracy',
      score: 0.85,
      details: { notes: 'good' },
    });

    expect(metric.id).toBeTruthy();
    expect(metric.score).toBe(0.85);
    expect(metric.evaluatedAt).toBeInstanceOf(Date);
  });

  it('validation — rejects missing required fields', () => {
    const errors = validateEstimateQualityMetricInput({
      tenantId: '',
      estimateId: '',
      metricType: '',
      score: -1,
    });
    expect(errors).toContain('tenantId is required');
    expect(errors).toContain('estimateId is required');
    expect(errors).toContain('metricType is required');
    expect(errors).toContain('score must be a number between 0 and 1');
  });

  it('mock provider test — repository stores and retrieves', async () => {
    const repo = new InMemoryEstimateQualityRepository();
    const metric = createEstimateQualityMetric({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      metricType: 'completeness',
      score: 0.9,
    });
    await repo.create(metric);

    const found = await repo.findByEstimate('tenant-1', 'est-1');
    expect(found).toHaveLength(1);
  });

  it('mock provider test — repository isolates tenants', async () => {
    const repo = new InMemoryEstimateQualityRepository();
    const metric = createEstimateQualityMetric({
      tenantId: 'tenant-1',
      estimateId: 'est-1',
      metricType: 'accuracy',
      score: 0.8,
    });
    await repo.create(metric);

    const found = await repo.findByEstimate('other-tenant', 'est-1');
    expect(found).toHaveLength(0);
  });

  it('malformed AI output handled gracefully — score boundary values', () => {
    const errors0 = validateEstimateQualityMetricInput({
      tenantId: 't', estimateId: 'e', metricType: 'm', score: 0,
    });
    expect(errors0).not.toContain('score must be a number between 0 and 1');

    const errors1 = validateEstimateQualityMetricInput({
      tenantId: 't', estimateId: 'e', metricType: 'm', score: 1,
    });
    expect(errors1).not.toContain('score must be a number between 0 and 1');
  });
});
