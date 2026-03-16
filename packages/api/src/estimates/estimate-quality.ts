import { v4 as uuidv4 } from 'uuid';

export interface EstimateQualityMetric {
  id: string;
  tenantId: string;
  estimateId: string;
  metricType: string;
  score: number;
  details?: Record<string, unknown>;
  evaluatedAt: Date;
}

export interface CreateEstimateQualityMetricInput {
  tenantId: string;
  estimateId: string;
  metricType: string;
  score: number;
  details?: Record<string, unknown>;
}

export interface EstimateQualityRepository {
  create(metric: EstimateQualityMetric): Promise<EstimateQualityMetric>;
  findByEstimate(tenantId: string, estimateId: string): Promise<EstimateQualityMetric[]>;
  findByTenant(tenantId: string): Promise<EstimateQualityMetric[]>;
}

export function validateEstimateQualityMetricInput(input: CreateEstimateQualityMetricInput): string[] {
  const errors: string[] = [];
  if (!input.tenantId) errors.push('tenantId is required');
  if (!input.estimateId) errors.push('estimateId is required');
  if (!input.metricType) errors.push('metricType is required');
  if (typeof input.score !== 'number' || input.score < 0 || input.score > 1) {
    errors.push('score must be a number between 0 and 1');
  }
  return errors;
}

export function createEstimateQualityMetric(input: CreateEstimateQualityMetricInput): EstimateQualityMetric {
  return {
    id: uuidv4(),
    tenantId: input.tenantId,
    estimateId: input.estimateId,
    metricType: input.metricType,
    score: input.score,
    details: input.details,
    evaluatedAt: new Date(),
  };
}

export class InMemoryEstimateQualityRepository implements EstimateQualityRepository {
  private metrics: Map<string, EstimateQualityMetric> = new Map();

  async create(metric: EstimateQualityMetric): Promise<EstimateQualityMetric> {
    this.metrics.set(metric.id, { ...metric });
    return { ...metric };
  }

  async findByEstimate(tenantId: string, estimateId: string): Promise<EstimateQualityMetric[]> {
    return Array.from(this.metrics.values())
      .filter((m) => m.tenantId === tenantId && m.estimateId === estimateId)
      .map((m) => ({ ...m }));
  }

  async findByTenant(tenantId: string): Promise<EstimateQualityMetric[]> {
    return Array.from(this.metrics.values())
      .filter((m) => m.tenantId === tenantId)
      .map((m) => ({ ...m }));
  }
}
