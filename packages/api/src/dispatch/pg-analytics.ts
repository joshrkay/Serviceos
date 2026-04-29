import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DispatchAnalyticsRepository,
  DispatchEventType,
  DispatchMetric,
} from './analytics';

function mapRow(row: Record<string, unknown>): DispatchMetric {
  const metadata = row.metadata as Record<string, unknown> | null | undefined;
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    eventType: row.event_type as DispatchEventType,
    appointmentId: (row.appointment_id as string | null) ?? undefined,
    technicianId: (row.technician_id as string | null) ?? undefined,
    metadata: metadata == null ? undefined : metadata,
    recordedAt: new Date(row.recorded_at as string),
  };
}

/**
 * Postgres-backed implementation of {@link DispatchAnalyticsRepository}.
 *
 * Tenant isolation: every query goes through `withTenant`, which sets
 * `app.current_tenant_id` so RLS filters automatically. Defense-in-depth:
 * every business query also includes `tenant_id = $1` and is fully
 * parameterized — tenant IDs are never concatenated into SQL strings.
 *
 * Mirrors the InMemory `DispatchAnalyticsRepository` interface exactly,
 * including the per-event (not aggregated) shape of `DispatchMetric`.
 */
export class PgDispatchAnalyticsRepository
  extends PgBaseRepository
  implements DispatchAnalyticsRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordMetric(metric: DispatchMetric): Promise<DispatchMetric> {
    return this.withTenant(metric.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO dispatch_analytics (
          id, tenant_id, event_type, appointment_id, technician_id, metadata, recorded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *`,
        [
          metric.id,
          metric.tenantId,
          metric.eventType,
          metric.appointmentId ?? null,
          metric.technicianId ?? null,
          metric.metadata ? JSON.stringify(metric.metadata) : null,
          metric.recordedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async getMetrics(
    tenantId: string,
    dateRange?: { from: Date; to: Date }
  ): Promise<DispatchMetric[]> {
    return this.withTenant(tenantId, async (client) => {
      if (dateRange) {
        const result = await client.query(
          `SELECT * FROM dispatch_analytics
           WHERE tenant_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
           ORDER BY recorded_at ASC`,
          [tenantId, dateRange.from, dateRange.to]
        );
        return result.rows.map(mapRow);
      }
      const result = await client.query(
        `SELECT * FROM dispatch_analytics
         WHERE tenant_id = $1
         ORDER BY recorded_at ASC`,
        [tenantId]
      );
      return result.rows.map(mapRow);
    });
  }

  async getMetricsByType(
    tenantId: string,
    eventType: DispatchEventType
  ): Promise<DispatchMetric[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM dispatch_analytics
         WHERE tenant_id = $1 AND event_type = $2
         ORDER BY recorded_at ASC`,
        [tenantId, eventType]
      );
      return result.rows.map(mapRow);
    });
  }
}
