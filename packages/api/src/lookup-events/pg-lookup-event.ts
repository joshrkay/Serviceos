import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DEFAULT_LOOKUP_EVENT_LIMIT,
  LookupEvent,
  LookupEventListOptions,
  LookupEventRepository,
  MAX_LOOKUP_EVENT_LIMIT,
} from './lookup-event';

function mapRow(row: Record<string, unknown>): LookupEvent {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    sessionId: row.session_id as string,
    customerId: (row.customer_id as string) ?? undefined,
    intent: row.intent as string,
    resultStatus: row.result_status as LookupEvent['resultStatus'],
    resultCount: Number(row.result_count),
    summary: row.summary as string,
    latencyMs: Number(row.latency_ms),
    createdAt: new Date(row.created_at as string),
  };
}

export class PgLookupEventRepository extends PgBaseRepository implements LookupEventRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(event: LookupEvent): Promise<LookupEvent> {
    return this.withTenant(event.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO lookup_events
           (id, tenant_id, session_id, customer_id, intent, result_status, result_count, summary, latency_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          event.id,
          event.tenantId,
          event.sessionId,
          event.customerId ?? null,
          event.intent,
          event.resultStatus,
          event.resultCount,
          event.summary,
          event.latencyMs,
          event.createdAt,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async listByTenant(
    tenantId: string,
    options?: LookupEventListOptions,
  ): Promise<LookupEvent[]> {
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let i = 2;
      if (options?.sessionId) {
        conditions.push(`session_id = $${i}`);
        params.push(options.sessionId);
        i++;
      }
      if (options?.customerId) {
        conditions.push(`customer_id = $${i}`);
        params.push(options.customerId);
        i++;
      }
      const limit = Math.min(options?.limit ?? DEFAULT_LOOKUP_EVENT_LIMIT, MAX_LOOKUP_EVENT_LIMIT);
      params.push(limit);
      const sql = `SELECT * FROM lookup_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`;
      const result = await client.query(sql, params);
      return result.rows.map(mapRow);
    });
  }
}
