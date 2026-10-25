/**
 * P0-020 — Postgres-backed webhook idempotency repository.
 *
 * Sits on top of the existing `webhook_events` table (created in migration
 * `012_create_webhook_events`, hardened in `049_create_webhook_events`).
 *
 * The semantics match the P0-020 spec — a (provider, event_id, event_type,
 * payload, received_at, processed_at, processing_error) shape — but we
 * deliberately reuse the underlying table to avoid a duplicate idempotency
 * source of truth. The column mapping is:
 *
 *   spec column        ←→ table column
 *   provider           ←→ source
 *   event_id           ←→ idempotency_key
 *   event_type         ←→ event_type
 *   payload            ←→ payload
 *   received_at        ←→ created_at
 *   processed_at       ←→ processed_at
 *   processing_error   ←→ error_message
 *
 * **Cross-tenant by design.** The Clerk `user.created` webhook fires
 * BEFORE the tenant exists (we use it to bootstrap the tenant), and the
 * Stripe webhook handler routes to the right tenant only AFTER dedup. That
 * means tenantId is unavailable at receipt time, so we use `withClient()`
 * (no tenant GUC) — same pattern as `platform_admins`. The unique index
 * on (source, idempotency_key) is what prevents duplicate processing,
 * including across tenants.
 *
 * U7-05+ — `payload` is stored minimized: `recordReceipt` keeps only the
 * source's allowlist (webhook-payload-allowlist.ts), never the caller's
 * name, phone, email or message, whatever the caller passes.
 */

import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { minimizeWebhookPayload } from './webhook-payload-allowlist';

export interface WebhookEventRecord {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt: Date | null;
  processingError: string | null;
}

export interface RecordReceiptResult {
  /** False when the (provider, event_id) pair was already seen. */
  inserted: boolean;
  record: WebhookEventRecord;
}

function mapRow(row: Record<string, unknown>): WebhookEventRecord {
  const payload = row.payload;
  const parsedPayload =
    typeof payload === 'string'
      ? (JSON.parse(payload) as Record<string, unknown>)
      : ((payload ?? {}) as Record<string, unknown>);
  return {
    id: row.id as string,
    provider: row.source as string,
    eventId: row.idempotency_key as string,
    eventType: row.event_type as string,
    payload: parsedPayload,
    receivedAt: new Date(row.created_at as string | Date),
    processedAt: row.processed_at ? new Date(row.processed_at as string | Date) : null,
    processingError: (row.error_message as string | null) ?? null,
  };
}

export class PgWebhookEventRepository extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /**
   * Idempotent receipt write. The CRITICAL idempotency primitive.
   *
   * Uses INSERT ... ON CONFLICT (source, idempotency_key) DO NOTHING. If
   * the row already exists we return inserted=false plus the existing
   * row, so the caller can skip processing without a second round-trip.
   * The payload is minimized first; a provider with no payload policy
   * throws before anything is written.
   */
  async recordReceipt(
    provider: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<RecordReceiptResult> {
    if (!provider) throw new Error('provider is required');
    if (!eventId) throw new Error('eventId is required');
    const stored = minimizeWebhookPayload(provider, eventType, payload);

    return this.withClient(async (client) => {
      const insertResult = await client.query(
        `INSERT INTO webhook_events (
           source, event_type, idempotency_key, payload, status, created_at
         ) VALUES ($1, $2, $3, $4, 'received', NOW())
         ON CONFLICT (source, idempotency_key) DO NOTHING
         RETURNING *`,
        [provider, eventType, eventId, JSON.stringify(stored)],
      );

      if (insertResult.rowCount && insertResult.rowCount > 0) {
        return { inserted: true, record: mapRow(insertResult.rows[0]) };
      }

      // Conflict — fetch the existing row so the caller can inspect it.
      const existing = await client.query(
        `SELECT * FROM webhook_events WHERE source = $1 AND idempotency_key = $2`,
        [provider, eventId],
      );
      if (existing.rows.length === 0) {
        // Should be impossible (we just hit a conflict), but guard anyway.
        throw new Error('webhook_events conflict reported but row missing');
      }
      return { inserted: false, record: mapRow(existing.rows[0]) };
    });
  }

  async markProcessed(provider: string, eventId: string): Promise<void> {
    await this.withClient(async (client) => {
      await client.query(
        `UPDATE webhook_events
            SET status = 'processed',
                processed_at = NOW(),
                error_message = NULL
          WHERE source = $1 AND idempotency_key = $2`,
        [provider, eventId],
      );
    });
  }

  async findById(provider: string, eventId: string): Promise<WebhookEventRecord | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM webhook_events WHERE source = $1 AND idempotency_key = $2`,
        [provider, eventId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
