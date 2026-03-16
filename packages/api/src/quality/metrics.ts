// P4-011A: Quality Metrics
// P4-012: Beta Benchmark
// Tracks AI quality metrics for estimates and proposals

export interface QualityMetrics {
  estimateApprovalRate: number;
  estimateCleanApprovalRate: number;
  estimateEditRate: number;
  estimateExecutionFailureRate: number;
  averageTimeToReviewMs: number;
  lowConfidenceRate: number;
  proposalExecutionSuccessRate: number;
  staleProposalRate: number;
  clarificationResolutionRate: number;
}

export interface MetricDataPoint {
  metricName: string;
  value: number;
  tenantId: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface QualityMetricsRepository {
  recordMetric(dataPoint: MetricDataPoint): Promise<void>;
  getMetrics(tenantId: string, startDate: Date, endDate: Date): Promise<MetricDataPoint[]>;
  getLatestMetrics(tenantId: string): Promise<QualityMetrics | null>;
  getMetricTimeSeries(
    tenantId: string,
    metricName: string,
    startDate: Date,
    endDate: Date
  ): Promise<MetricDataPoint[]>;
}

// Beta threshold gates
export const ESTIMATE_BETA_THRESHOLDS = {
  approvalRate: 0.7,           // > 70%
  cleanApprovalRate: 0.3,       // > 30%
  editRate: 0.4,                // < 40%
  executionFailureRate: 0.05,   // < 5%
  averageTimeToReviewMs: 90000, // < 90 seconds
  lowConfidenceRate: 0.25,      // < 25%
} as const;

export const PROPOSAL_BETA_THRESHOLDS = {
  executionSuccessRate: 0.99,       // > 99%
  staleProposalRate: 0.1,           // < 10%
  clarificationResolutionRate: 0.6, // > 60%
} as const;

export interface BetaReadinessResult {
  isReady: boolean;
  checks: BetaReadinessCheck[];
  overallScore: number;
}

export interface BetaReadinessCheck {
  metric: string;
  currentValue: number;
  threshold: number;
  comparison: 'gte' | 'lte';
  passed: boolean;
}

export function evaluateBetaReadiness(metrics: QualityMetrics): BetaReadinessResult {
  const checks: BetaReadinessCheck[] = [
    {
      metric: 'estimateApprovalRate',
      currentValue: metrics.estimateApprovalRate,
      threshold: ESTIMATE_BETA_THRESHOLDS.approvalRate,
      comparison: 'gte',
      passed: metrics.estimateApprovalRate >= ESTIMATE_BETA_THRESHOLDS.approvalRate,
    },
    {
      metric: 'estimateCleanApprovalRate',
      currentValue: metrics.estimateCleanApprovalRate,
      threshold: ESTIMATE_BETA_THRESHOLDS.cleanApprovalRate,
      comparison: 'gte',
      passed: metrics.estimateCleanApprovalRate >= ESTIMATE_BETA_THRESHOLDS.cleanApprovalRate,
    },
    {
      metric: 'estimateEditRate',
      currentValue: metrics.estimateEditRate,
      threshold: ESTIMATE_BETA_THRESHOLDS.editRate,
      comparison: 'lte',
      passed: metrics.estimateEditRate <= ESTIMATE_BETA_THRESHOLDS.editRate,
    },
    {
      metric: 'estimateExecutionFailureRate',
      currentValue: metrics.estimateExecutionFailureRate,
      threshold: ESTIMATE_BETA_THRESHOLDS.executionFailureRate,
      comparison: 'lte',
      passed: metrics.estimateExecutionFailureRate <= ESTIMATE_BETA_THRESHOLDS.executionFailureRate,
    },
    {
      metric: 'averageTimeToReviewMs',
      currentValue: metrics.averageTimeToReviewMs,
      threshold: ESTIMATE_BETA_THRESHOLDS.averageTimeToReviewMs,
      comparison: 'lte',
      passed: metrics.averageTimeToReviewMs <= ESTIMATE_BETA_THRESHOLDS.averageTimeToReviewMs,
    },
    {
      metric: 'lowConfidenceRate',
      currentValue: metrics.lowConfidenceRate,
      threshold: ESTIMATE_BETA_THRESHOLDS.lowConfidenceRate,
      comparison: 'lte',
      passed: metrics.lowConfidenceRate <= ESTIMATE_BETA_THRESHOLDS.lowConfidenceRate,
    },
    {
      metric: 'proposalExecutionSuccessRate',
      currentValue: metrics.proposalExecutionSuccessRate,
      threshold: PROPOSAL_BETA_THRESHOLDS.executionSuccessRate,
      comparison: 'gte',
      passed: metrics.proposalExecutionSuccessRate >= PROPOSAL_BETA_THRESHOLDS.executionSuccessRate,
    },
    {
      metric: 'staleProposalRate',
      currentValue: metrics.staleProposalRate,
      threshold: PROPOSAL_BETA_THRESHOLDS.staleProposalRate,
      comparison: 'lte',
      passed: metrics.staleProposalRate <= PROPOSAL_BETA_THRESHOLDS.staleProposalRate,
    },
    {
      metric: 'clarificationResolutionRate',
      currentValue: metrics.clarificationResolutionRate,
      threshold: PROPOSAL_BETA_THRESHOLDS.clarificationResolutionRate,
      comparison: 'gte',
      passed: metrics.clarificationResolutionRate >= PROPOSAL_BETA_THRESHOLDS.clarificationResolutionRate,
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const overallScore = passedCount / checks.length;
  const isReady = checks.every((c) => c.passed);

  return { isReady, checks, overallScore };
}

export function computeQualityMetrics(data: {
  totalEstimateProposals: number;
  approvedEstimates: number;
  cleanApprovals: number;
  editedApprovals: number;
  rejectedEstimates: number;
  executionFailures: number;
  totalReviewTimeMs: number;
  reviewCount: number;
  lowConfidenceCount: number;
  totalProposals: number;
  successfulExecutions: number;
  staleProposals: number;
  clarificationsSent: number;
  clarificationsResolved: number;
}): QualityMetrics {
  const totalEstimateDecisions = data.approvedEstimates + data.rejectedEstimates;
  const totalApproved = data.cleanApprovals + data.editedApprovals;

  return {
    estimateApprovalRate:
      totalEstimateDecisions > 0 ? totalApproved / totalEstimateDecisions : 0,
    estimateCleanApprovalRate:
      totalEstimateDecisions > 0 ? data.cleanApprovals / totalEstimateDecisions : 0,
    estimateEditRate:
      totalApproved > 0 ? data.editedApprovals / totalApproved : 0,
    estimateExecutionFailureRate:
      totalApproved > 0 ? data.executionFailures / totalApproved : 0,
    averageTimeToReviewMs:
      data.reviewCount > 0 ? data.totalReviewTimeMs / data.reviewCount : 0,
    lowConfidenceRate:
      data.totalEstimateProposals > 0 ? data.lowConfidenceCount / data.totalEstimateProposals : 0,
    proposalExecutionSuccessRate:
      data.totalProposals > 0 ? data.successfulExecutions / data.totalProposals : 0,
    staleProposalRate:
      data.totalProposals > 0 ? data.staleProposals / data.totalProposals : 0,
    clarificationResolutionRate:
      data.clarificationsSent > 0 ? data.clarificationsResolved / data.clarificationsSent : 0,
  };
}

export class InMemoryQualityMetricsRepository implements QualityMetricsRepository {
  private dataPoints: MetricDataPoint[] = [];
  private latestMetrics: Map<string, QualityMetrics> = new Map();

  async recordMetric(dataPoint: MetricDataPoint): Promise<void> {
    this.dataPoints.push(dataPoint);
  }

  async getMetrics(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<MetricDataPoint[]> {
    return this.dataPoints.filter(
      (dp) =>
        dp.tenantId === tenantId &&
        dp.timestamp >= startDate &&
        dp.timestamp <= endDate
    );
  }

  async getLatestMetrics(tenantId: string): Promise<QualityMetrics | null> {
    return this.latestMetrics.get(tenantId) ?? null;
  }

  setLatestMetrics(tenantId: string, metrics: QualityMetrics): void {
    this.latestMetrics.set(tenantId, metrics);
  }

  async getMetricTimeSeries(
    tenantId: string,
    metricName: string,
    startDate: Date,
    endDate: Date
  ): Promise<MetricDataPoint[]> {
    return this.dataPoints.filter(
      (dp) =>
        dp.tenantId === tenantId &&
        dp.metricName === metricName &&
        dp.timestamp >= startDate &&
        dp.timestamp <= endDate
    );
  }
}
