import { v4 as uuidv4 } from 'uuid';

export type DispatchEventType =
  | 'assigned'
  | 'reassigned'
  | 'rescheduled'
  | 'canceled'
  | 'conflict_detected';

export interface DispatchMetric {
  id: string;
  tenantId: string;
  eventType: DispatchEventType;
  appointmentId?: string;
  technicianId?: string;
  metadata?: Record<string, unknown>;
  recordedAt: Date;
}

export interface DispatchMetricSummary {
  totalEvents: number;
  byType: Record<string, number>;
  dateRange?: { from: Date; to: Date };
}

export interface DispatchAnalyticsRepository {
  recordMetric(metric: DispatchMetric): Promise<DispatchMetric>;
  getMetrics(tenantId: string, dateRange?: { from: Date; to: Date }): Promise<DispatchMetric[]>;
  getMetricsByType(tenantId: string, eventType: DispatchEventType): Promise<DispatchMetric[]>;
}

export class InMemoryDispatchAnalyticsRepository implements DispatchAnalyticsRepository {
  private metrics: DispatchMetric[] = [];

  async recordMetric(metric: DispatchMetric): Promise<DispatchMetric> {
    const stored = { ...metric };
    this.metrics.push(stored);
    return { ...stored };
  }

  async getMetrics(tenantId: string, dateRange?: { from: Date; to: Date }): Promise<DispatchMetric[]> {
    return this.metrics
      .filter((m) => m.tenantId === tenantId)
      .filter((m) => {
        if (!dateRange) return true;
        return m.recordedAt >= dateRange.from && m.recordedAt <= dateRange.to;
      })
      .map((m) => ({ ...m }));
  }

  async getMetricsByType(tenantId: string, eventType: DispatchEventType): Promise<DispatchMetric[]> {
    return this.metrics
      .filter((m) => m.tenantId === tenantId && m.eventType === eventType)
      .map((m) => ({ ...m }));
  }
}

export function createDispatchMetric(
  tenantId: string,
  eventType: DispatchEventType,
  options?: {
    appointmentId?: string;
    technicianId?: string;
    metadata?: Record<string, unknown>;
  }
): DispatchMetric {
  return {
    id: uuidv4(),
    tenantId,
    eventType,
    appointmentId: options?.appointmentId,
    technicianId: options?.technicianId,
    metadata: options?.metadata,
    recordedAt: new Date(),
  };
}

export async function captureDispatchEvent(
  repo: DispatchAnalyticsRepository,
  tenantId: string,
  eventType: DispatchEventType,
  options?: {
    appointmentId?: string;
    technicianId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<DispatchMetric> {
  const metric = createDispatchMetric(tenantId, eventType, options);
  return repo.recordMetric(metric);
}

export async function getDispatchSummary(
  repo: DispatchAnalyticsRepository,
  tenantId: string,
  dateRange?: { from: Date; to: Date }
): Promise<DispatchMetricSummary> {
  const metrics = await repo.getMetrics(tenantId, dateRange);
  const byType: Record<string, number> = {};

  for (const metric of metrics) {
    byType[metric.eventType] = (byType[metric.eventType] || 0) + 1;
  }

  return {
    totalEvents: metrics.length,
    byType,
    dateRange,
  };
}
