import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { WebhookEvent, WebhookRepository } from './webhook-handler';

function mapRow(row: Record<string, unknown>): WebhookEvent {
  return {
    id: row.id as string,
    source: row.source as string,
    eventType: row.event_type as string,
    idempotencyKey: row.idempotency_key as string,
    payload: row.payload as Record<string, unknown>,
    status: row.status as WebhookEvent['status'],
    errorMessage: row.error_message as string | undefined,
    processedAt: row.processed_at ? new Date(row.processed_at as string) : undefined,
    createdAt: new Date(row.created_at as string),
  };
}

export class PgWebhookRepository extends PgBaseRepository implements WebhookRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async findByIdempotencyKey(source: string, idempotencyKey: string): Promise<WebhookEvent | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM webhook_events WHERE source = $1 AND idempotency_key = $2`,
        [source, idempotencyKey]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async create(event: WebhookEvent): Promise<WebhookEvent> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `INSERT INTO webhook_events (id, source, event_type, idempotency_key, payload, status, error_message, processed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          event.id,
          event.source,
          event.eventType,
          event.idempotencyKey,
          JSON.stringify(event.payload),
          event.status,
          event.errorMessage ?? null,
          event.processedAt ?? null,
          event.createdAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  async updateStatus(id: string, status: WebhookEvent['status'], error?: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE webhook_events
         SET status = $1,
             error_message = COALESCE($2, error_message),
             processed_at = CASE WHEN $1 = 'processed' THEN NOW() ELSE processed_at END
         WHERE id = $3`,
        [status, error ?? null, id]
      );
    });
  }
}
