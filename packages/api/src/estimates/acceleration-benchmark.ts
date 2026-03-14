import { VerticalType } from '../shared/vertical-types';
import { VerticalEstimateQuality } from './vertical-quality-metrics';

export interface AccelerationBenchmark {
  tenantId: string;
  verticalType: VerticalType;
  manualEstimateTimeMs?: number;
  aiAssistedEstimateTimeMs?: number;
  timeSavingsPercent?: number;
  qualityScore: number;
  sampleSize: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface BenchmarkOptions {
  manualEstimateTimeMs?: number;
  aiAssistedEstimateTimeMs?: number;
}

export function computeAccelerationBenchmark(
  tenantId: string,
  verticalType: VerticalType,
  qualityMetrics: VerticalEstimateQuality,
  options: BenchmarkOptions = {}
): AccelerationBenchmark {
  const { manualEstimateTimeMs, aiAssistedEstimateTimeMs } = options;

  let timeSavingsPercent: number | undefined;
  if (manualEstimateTimeMs && aiAssistedEstimateTimeMs && manualEstimateTimeMs > 0) {
    timeSavingsPercent = ((manualEstimateTimeMs - aiAssistedEstimateTimeMs) / manualEstimateTimeMs) * 100;
  }

  // Quality score: weighted combination of approval rate, accuracy, and low edit rate
  const qualityScore = computeQualityScore(qualityMetrics);

  return {
    tenantId,
    verticalType,
    manualEstimateTimeMs,
    aiAssistedEstimateTimeMs,
    timeSavingsPercent,
    qualityScore,
    sampleSize: qualityMetrics.sampleSize,
    periodStart: qualityMetrics.periodStart,
    periodEnd: qualityMetrics.periodEnd,
  };
}

function computeQualityScore(metrics: VerticalEstimateQuality): number {
  if (metrics.sampleSize === 0) return 0;

  // Weighted: 40% approval rate, 30% line item accuracy, 30% (1 - edit rate)
  const score =
    metrics.approvalRate * 0.4 +
    metrics.lineItemAccuracy * 0.3 +
    (1 - metrics.editRate) * 0.3;

  return Math.round(score * 100) / 100;
}
