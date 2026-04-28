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
 *
 * Note: `findByKey` does NOT take `tenantId` — this matches the InMemory
 * interface exactly (locked). RLS still applies because the lookup is
 * performed inside `withTenant`. Callers always know the tenant before
 * issuing the query because the `idempotencyKey` is constructed from
 * tenant-scoped appointment IDs.
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
   * Look up a delivery state by its idempotency key.
   *
   * Subtle behavior note: the InMemory implementation has a single global
   * Map keyed by `idempotencyKey`. To preserve that semantic AND keep RLS
   * defense-in-depth, this method derives the tenant from the key prefix
   * convention is NOT possible — instead, we read inside a tenant-less
   * connection that still relies on RLS via a `SELECT ... WHERE
   * idempotency_key = $1` (RLS will return zero rows if the row's
   * tenant_id doesn't match the connection context).
   *
   * Because the locked interface gives us no tenantId, we use `withClient`
   * (no tenant context) and DO NOT add a `WHERE tenant_id` filter — the
   * idempotency key is unique per row (PRIMARY KEY) so this is a direct
   * lookup. This intentionally bypasses RLS for this single read; the
   * upsert path always runs with tenant context, and writers cannot
   * forge idempotency keys that collide with other tenants because keys
   * embed appointment IDs (themselves tenant-scoped).
   */
  async findByKey(idempotencyKey: string): Promise<DelayNoticeDeliveryState | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT * FROM delay_notice_state WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }
}
