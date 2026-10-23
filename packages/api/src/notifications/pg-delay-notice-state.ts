import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  DelayNoticeDeliveryState,
  DelayNoticeStateRepository,
  DelayNotificationChannel,
} from './delay-notifications';

function mapRow(row: Record<string, unknown>): DelayNoticeDeliveryState {
  const triggerContext = row.trigger_context as Record<string, unknown> | null | undefined;
  return {
    idempotencyKey: row.idempotency_key as string,
    tenantId: row.tenant_id as string,
    appointmentId: row.appointment_id as string,
    delayVersion: row.delay_version as number,
    status: row.status as DelayNoticeDeliveryState['status'],
    channel: row.channel as DelayNotificationChannel,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string | null) ?? undefined,
    providerMessageId: (row.provider_message_id as string | null) ?? undefined,
    triggerContext: triggerContext == null ? undefined : triggerContext,
    updatedAt: new Date(row.updated_at as string),
  };
}

/**
 * Postgres-backed implementation of {@link DelayNoticeStateRepository}.
 *
 * The PRIMARY KEY is `idempotency_key` so re-deliveries / retries upsert
 * the same row in place (mirrors the InMemory `Map.set` semantics).
 */
export class PgDelayNoticeStateRepository
  extends PgBaseRepository
  implements DelayNoticeStateRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async upsert(state: DelayNoticeDeliveryState): Promise<DelayNoticeDeliveryState> {
    return this.withTenant(state.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO delay_notice_state (
          idempotency_key, tenant_id, appointment_id, delay_version,
          status, channel, attempts, max_attempts,
          last_error, provider_message_id, trigger_context, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          tenant_id = EXCLUDED.tenant_id,
          appointment_id = EXCLUDED.appointment_id,
          delay_version = EXCLUDED.delay_version,
          status = EXCLUDED.status,
          channel = EXCLUDED.channel,
          attempts = EXCLUDED.attempts,
          max_attempts = EXCLUDED.max_attempts,
          last_error = EXCLUDED.last_error,
          provider_message_id = EXCLUDED.provider_message_id,
          trigger_context = EXCLUDED.trigger_context,
          updated_at = EXCLUDED.updated_at
        RETURNING *`,
        [
          state.idempotencyKey,
          state.tenantId,
          state.appointmentId,
          state.delayVersion,
          state.status,
          state.channel,
          state.attempts,
          state.maxAttempts,
          state.lastError ?? null,
          state.providerMessageId ?? null,
          state.triggerContext ? JSON.stringify(state.triggerContext) : null,
          state.updatedAt,
        ]
      );
      return mapRow(result.rows[0]);
    });
  }

  /**
   * Look up a delivery state by its idempotency key, within `tenantId`.
   *
   * Runs inside `withTenant` (tenant GUC + the RLS runtime role) and also
   * filters on `tenant_id`, so another tenant's row is invisible to this read
   * whichever of the two backstops is active. Inside a request it reuses the
   * request's client instead of taking a second pooled connection.
   */
  async findByKey(tenantId: string, idempotencyKey: string): Promise<DelayNoticeDeliveryState | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM delay_notice_state WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
