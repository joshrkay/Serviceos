import {
  evaluateBetaReadiness,
  computeQualityMetrics,
  InMemoryQualityMetricsRepository,
  ESTIMATE_BETA_THRESHOLDS,
  PROPOSAL_BETA_THRESHOLDS,
  QualityMetrics,
} from '../../src/quality/metrics';

describe('P4-011/012 — Quality Metrics + Beta Benchmark', () => {
  let repo: InMemoryQualityMetricsRepository;

  beforeEach(() => {
    repo = new InMemoryQualityMetricsRepository();
  });

  const passingMetrics: QualityMetrics = {
    estimateApprovalRate: 0.8,
    estimateCleanApprovalRate: 0.45,
    estimateEditRate: 0.3,
    estimateExecutionFailureRate: 0.02,
    averageTimeToReviewMs: 45000,
    lowConfidenceRate: 0.15,
    proposalExecutionSuccessRate: 0.995,
    staleProposalRate: 0.05,
    clarificationResolutionRate: 0.7,
  };

  it('evaluates beta readiness — all passing', () => {
    const result = evaluateBetaReadiness(passingMetrics);
    expect(result.isReady).toBe(true);
    expect(result.overallScore).toBe(1);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('evaluates beta readiness — failing approval rate', () => {
    const result = evaluateBetaReadiness({
      ...passingMetrics,
      estimateApprovalRate: 0.5, // below 0.7 threshold
    });
    expect(result.isReady).toBe(false);
    const failedCheck = result.checks.find((c) => c.metric === 'estimateApprovalRate');
    expect(failedCheck!.passed).toBe(false);
  });

  it('evaluates beta readiness — failing edit rate', () => {
    const result = evaluateBetaReadiness({
      ...passingMetrics,
      estimateEditRate: 0.55, // above 0.4 threshold
    });
    expect(result.isReady).toBe(false);
  });

  it('evaluates beta readiness — failing execution rate', () => {
    const result = evaluateBetaReadiness({
      ...passingMetrics,
      proposalExecutionSuccessRate: 0.95, // below 0.99
    });
    expect(result.isReady).toBe(false);
  });

  it('computes quality metrics from raw data', () => {
    const metrics = computeQualityMetrics({
      totalEstimateProposals: 100,
      approvedEstimates: 70,
      cleanApprovals: 40,
      editedApprovals: 30,
      rejectedEstimates: 20,
      executionFailures: 2,
      totalReviewTimeMs: 4500000, // 45 reviews
      reviewCount: 45,
      lowConfidenceCount: 15,
      totalProposals: 200,
      successfulExecutions: 195,
      staleProposals: 10,
      clarificationsSent: 30,
      clarificationsResolved: 20,
    });

    expect(metrics.estimateApprovalRate).toBeCloseTo(0.778, 2); // 70/90
    expect(metrics.estimateCleanApprovalRate).toBeCloseTo(0.444, 2); // 40/90
    expect(metrics.estimateEditRate).toBeCloseTo(0.429, 2); // 30/70
    expect(metrics.estimateExecutionFailureRate).toBeCloseTo(0.029, 2); // 2/70
    expect(metrics.averageTimeToReviewMs).toBe(100000); // 4500000/45
    expect(metrics.lowConfidenceRate).toBe(0.15); // 15/100
    expect(metrics.proposalExecutionSuccessRate).toBe(0.975); // 195/200
    expect(metrics.staleProposalRate).toBe(0.05); // 10/200
    expect(metrics.clarificationResolutionRate).toBeCloseTo(0.667, 2); // 20/30
  });

  it('handles zero-division in metrics', () => {
    const metrics = computeQualityMetrics({
      totalEstimateProposals: 0,
      approvedEstimates: 0,
      cleanApprovals: 0,
      editedApprovals: 0,
      rejectedEstimates: 0,
      executionFailures: 0,
      totalReviewTimeMs: 0,
      reviewCount: 0,
      lowConfidenceCount: 0,
      totalProposals: 0,
      successfulExecutions: 0,
      staleProposals: 0,
      clarificationsSent: 0,
      clarificationsResolved: 0,
    });

    expect(metrics.estimateApprovalRate).toBe(0);
    expect(metrics.estimateCleanApprovalRate).toBe(0);
    expect(metrics.estimateEditRate).toBe(0);
    expect(metrics.averageTimeToReviewMs).toBe(0);
  });

  it('records and retrieves metric data points', async () => {
    const now = new Date();
    await repo.recordMetric({
      metricName: 'estimateApprovalRate',
      value: 0.75,
      tenantId: 'tenant-1',
      timestamp: now,
    });

    const results = await repo.getMetrics(
      'tenant-1',
      new Date(now.getTime() - 1000),
      new Date(now.getTime() + 1000)
    );
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(0.75);
  });

  it('retrieves metric time series', async () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      await repo.recordMetric({
        metricName: 'estimateApprovalRate',
        value: 0.6 + i * 0.05,
        tenantId: 'tenant-1',
        timestamp: new Date(base + i * 3600000),
      });
    }

    const series = await repo.getMetricTimeSeries(
      'tenant-1',
      'estimateApprovalRate',
      new Date(base - 1000),
      new Date(base + 5 * 3600000)
    );
    expect(series).toHaveLength(5);
  });

  it('stores and retrieves latest metrics', async () => {
    repo.setLatestMetrics('tenant-1', passingMetrics);
    const retrieved = await repo.getLatestMetrics('tenant-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.estimateApprovalRate).toBe(0.8);
  });

  it('returns null for unknown tenant metrics', async () => {
    const result = await repo.getLatestMetrics('unknown-tenant');
    expect(result).toBeNull();
  });

  it('beta thresholds match PRD specifications', () => {
    expect(ESTIMATE_BETA_THRESHOLDS.approvalRate).toBe(0.7);
    expect(ESTIMATE_BETA_THRESHOLDS.cleanApprovalRate).toBe(0.3);
    expect(ESTIMATE_BETA_THRESHOLDS.editRate).toBe(0.4);
    expect(ESTIMATE_BETA_THRESHOLDS.executionFailureRate).toBe(0.05);
    expect(ESTIMATE_BETA_THRESHOLDS.averageTimeToReviewMs).toBe(90000);
    expect(ESTIMATE_BETA_THRESHOLDS.lowConfidenceRate).toBe(0.25);
    expect(PROPOSAL_BETA_THRESHOLDS.executionSuccessRate).toBe(0.99);
    expect(PROPOSAL_BETA_THRESHOLDS.staleProposalRate).toBe(0.1);
    expect(PROPOSAL_BETA_THRESHOLDS.clarificationResolutionRate).toBe(0.6);
  });
});
