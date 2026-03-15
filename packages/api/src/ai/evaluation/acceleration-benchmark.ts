import { v4 as uuidv4 } from 'uuid';
import { Estimate } from '../../estimates/estimate';
import { VerticalQualityMetric } from './vertical-quality-metrics';

export interface AccelerationMetrics {
  estimatesGenerated: number;
  estimatesApproved: number;
  approvalRate: number;
  avgEditDistance: number;
  avgTimeToApproval?: number;
  qualityScoreAvg: number;
  qualityScoreTrend: number;
}

export interface AccelerationBenchmark {
  id: string;
  tenantId: string;
  verticalSlug: string;
  periodStart: Date;
  periodEnd: Date;
  metrics: AccelerationMetrics;
  createdAt: Date;
}

export interface AccelerationBenchmarkRepository {
  create(benchmark: AccelerationBenchmark): Promise<AccelerationBenchmark>;
  findByTenant(tenantId: string): Promise<AccelerationBenchmark[]>;
  findByVertical(tenantId: string, verticalSlug: string): Promise<AccelerationBenchmark[]>;
  findLatest(tenantId: string, verticalSlug: string): Promise<AccelerationBenchmark | null>;
}

export function calculateAccelerationMetrics(
  estimates: Estimate[],
  qualityMetrics: VerticalQualityMetric[]
): AccelerationMetrics {
  const approved = estimates.filter((e) => e.status === 'approved');
  const approvalRate = calculateApprovalRate(estimates);
  const avgEditDistance = calculateAvgEditDistance(estimates);
  const qualityScoreAvg = qualityMetrics.length > 0
    ? qualityMetrics.reduce((sum, m) => sum + m.score, 0) / qualityMetrics.length
    : 0;
  const qualityScoreTrend = calculateQualityTrend(qualityMetrics);

  return {
    estimatesGenerated: estimates.length,
    estimatesApproved: approved.length,
    approvalRate,
    avgEditDistance,
    qualityScoreAvg,
    qualityScoreTrend,
  };
}

export function createAccelerationBenchmark(
  tenantId: string,
  verticalSlug: string,
  periodStart: Date,
  periodEnd: Date,
  metrics: AccelerationMetrics
): AccelerationBenchmark {
  return {
    id: uuidv4(),
    tenantId,
    verticalSlug,
    periodStart,
    periodEnd,
    metrics,
    createdAt: new Date(),
  };
}

export function calculateApprovalRate(estimates: Estimate[]): number {
  if (estimates.length === 0) return 0;
  const approved = estimates.filter((e) => e.status === 'approved').length;
  return approved / estimates.length;
}

export function calculateAvgEditDistance(estimates: Estimate[]): number {
  if (estimates.length === 0) return 0;
  // Approximation: estimates that went from ai_generated and got approved
  // have lower edit distance than those that were rejected
  const aiGenerated = estimates.filter((e) => e.source === 'ai_generated');
  if (aiGenerated.length === 0) return 0;
  const approved = aiGenerated.filter((e) => e.status === 'approved').length;
  // Lower edit distance correlates with higher approval rate
  return 1 - (approved / aiGenerated.length);
}

export function calculateQualityTrend(metrics: VerticalQualityMetric[]): number {
  if (metrics.length < 2) return 0;

  const sorted = [...metrics].sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime());
  const midpoint = Math.floor(sorted.length / 2);

  const firstHalf = sorted.slice(0, midpoint);
  const secondHalf = sorted.slice(midpoint);

  const firstAvg = firstHalf.reduce((sum, m) => sum + m.score, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((sum, m) => sum + m.score, 0) / secondHalf.length;

  return secondAvg - firstAvg;
}

export class InMemoryAccelerationBenchmarkRepository implements AccelerationBenchmarkRepository {
  private benchmarks: Map<string, AccelerationBenchmark> = new Map();

  async create(benchmark: AccelerationBenchmark): Promise<AccelerationBenchmark> {
    this.benchmarks.set(benchmark.id, { ...benchmark });
    return { ...benchmark };
  }

  async findByTenant(tenantId: string): Promise<AccelerationBenchmark[]> {
    return Array.from(this.benchmarks.values())
      .filter((b) => b.tenantId === tenantId)
      .map((b) => ({ ...b }));
  }

  async findByVertical(tenantId: string, verticalSlug: string): Promise<AccelerationBenchmark[]> {
    return Array.from(this.benchmarks.values())
      .filter((b) => b.tenantId === tenantId && b.verticalSlug === verticalSlug)
      .map((b) => ({ ...b }));
  }

  async findLatest(tenantId: string, verticalSlug: string): Promise<AccelerationBenchmark | null> {
    const matches = Array.from(this.benchmarks.values())
      .filter((b) => b.tenantId === tenantId && b.verticalSlug === verticalSlug)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches.length > 0 ? { ...matches[0] } : null;
  }
}
