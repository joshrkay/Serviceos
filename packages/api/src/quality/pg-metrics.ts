import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  MetricDataPoint,
  QualityMetrics,
  QualityMetricsRepository,
} from './metrics';
import { v4 as uuidv4 } from 'uuid';

function rowToDataPoint(row: Record<string, unknown>): MetricDataPoint {
  return {
    metricName: row.metric_name as string,
    value: Number(row.value),
    tenantId: row.tenant_id as string,
    timestamp: new Date(row.recorded_at as string),
    metadata: row.metadata
      ? (typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata) as Record<string, unknown>
      : undefined,
  };
}

const METRIC_NAME_MAP: Record<string, keyof QualityMetrics> = {
  estimateApprovalRate: 'estimateApprovalRate',
  estimateCleanApprovalRate: 'estimateCleanApprovalRate',
  estimateEditRate: 'estimateEditRate',
  estimateExecutionFailureRate: 'estimateExecutionFailureRate',
  averageTimeToReviewMs: 'averageTimeToReviewMs',
  lowConfidenceRate: 'lowConfidenceRate',
  proposalExecutionSuccessRate: 'proposalExecutionSuccessRate',
  staleProposalRate: 'staleProposalRate',
  clarificationResolutionRate: 'clarificationResolutionRate',
};

export class PgQualityMetricsRepository
  extends PgBaseRepository
  implements QualityMetricsRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordMetric(dataPoint: MetricDataPoint): Promise<void> {
    await this.withTenant(dataPoint.tenantId, async (client) => {
      await client.query(
        `INSERT INTO quality_metrics (id, tenant_id, metric_name, value, metadata, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuidv4(),
          dataPoint.tenantId,
          dataPoint.metricName,
          dataPoint.value,
          dataPoint.metadata ? JSON.stringify(dataPoint.metadata) : null,
          dataPoint.timestamp,
        ]
      );
    });
  }

  async getMetrics(
    tenantId: string,
    startDate: Date,
    endDate: Date
  ): Promise<MetricDataPoint[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM quality_metrics
         WHERE tenant_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
         ORDER BY recorded_at ASC`,
        [tenantId, startDate, endDate]
      );
      return result.rows.map(rowToDataPoint);
    });
  }

  async getLatestMetrics(tenantId: string): Promise<QualityMetrics | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT DISTINCT ON (metric_name) metric_name, value
         FROM quality_metrics
         WHERE tenant_id = $1
         ORDER BY metric_name, recorded_at DESC`,
        [tenantId]
      );

      if (result.rows.length === 0) return null;

      const metrics: QualityMetrics = {
        estimateApprovalRate: 0,
        estimateCleanApprovalRate: 0,
        estimateEditRate: 0,
        estimateExecutionFailureRate: 0,
        averageTimeToReviewMs: 0,
        lowConfidenceRate: 0,
        proposalExecutionSuccessRate: 0,
        staleProposalRate: 0,
        clarificationResolutionRate: 0,
      };

      for (const row of result.rows) {
        const key = METRIC_NAME_MAP[row.metric_name as string];
        if (key) {
          metrics[key] = Number(row.value);
        }
      }

      return metrics;
    });
  }

  async getMetricTimeSeries(
    tenantId: string,
    metricName: string,
    startDate: Date,
    endDate: Date
  ): Promise<MetricDataPoint[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM quality_metrics
         WHERE tenant_id = $1 AND metric_name = $2
           AND recorded_at >= $3 AND recorded_at <= $4
         ORDER BY recorded_at ASC`,
        [tenantId, metricName, startDate, endDate]
      );
      return result.rows.map(rowToDataPoint);
    });
  }
}
