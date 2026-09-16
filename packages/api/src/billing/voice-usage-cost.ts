import type { Pool } from "pg";
import { PgBaseRepository } from "../db/pg-base";

export type VoiceCostProvider =
  | "twilio"
  | "stt"
  | "tts"
  | "llm"
  | "infrastructure";

export interface RecordVoiceUsageCostInput {
  id: string;
  tenantId: string;
  /** Voice session/call whose elapsed AI time consumes the included allowance. */
  sessionId: string;
  /** Provider event/request id; makes retries idempotent within a provider. */
  sourceId: string;
  provider: VoiceCostProvider;
  usageSeconds: number;
  providerCostMicroCents: number;
  occurredAt: Date;
}

export interface VoiceUsagePeriodSummary {
  usageSeconds: number;
  providerCostMicroCents: number;
  providers: VoiceCostProvider[];
  incompleteSessionCount: number;
}

export interface VoiceUsageCostRepository {
  record(input: RecordVoiceUsageCostInput): Promise<void>;
  summarizePeriod(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<VoiceUsagePeriodSummary>;
  queueTwilioReconciliation(input: TwilioReconciliationInput): Promise<string>;
  findDueTwilio(
    tenantId: string,
    now: Date,
    limit?: number,
  ): Promise<TwilioReconciliationRow[]>;
  completeTwilio(tenantId: string, id: string): Promise<void>;
  deferTwilio(
    tenantId: string,
    id: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void>;
}

export interface TwilioReconciliationInput {
  id: string;
  tenantId: string;
  sessionId: string;
  callSid: string;
  accountSid: string;
  usageSeconds: number;
  mediaStreamsUsed: boolean;
  occurredAt: Date;
}

export interface TwilioReconciliationRow extends TwilioReconciliationInput {
  attempts: number;
}

/** Durable, idempotent source ledger for every component of blended voice cost. */
export class PgVoiceUsageCostRepository
  extends PgBaseRepository
  implements VoiceUsageCostRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async record(input: RecordVoiceUsageCostInput): Promise<void> {
    await this.withTenant(input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_voice_usage_costs
           (id, tenant_id, session_id, source_id, provider, usage_seconds,
            provider_cost_micro_cents, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, provider, source_id) DO NOTHING`,
        [
          input.id,
          input.tenantId,
          input.sessionId,
          input.sourceId,
          input.provider,
          input.usageSeconds,
          input.providerCostMicroCents,
          input.occurredAt,
        ],
      );
    });
  }

  async summarizePeriod(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<VoiceUsagePeriodSummary> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<{
        usage_seconds: string;
        provider_cost_micro_cents: string;
        providers: VoiceCostProvider[];
        incomplete_session_count: string;
      }>(
        `WITH per_session AS (
           SELECT session_id,
                  MAX(usage_seconds) AS usage_seconds,
                  SUM(provider_cost_micro_cents) AS provider_cost_micro_cents,
                  COUNT(DISTINCT provider) FILTER (WHERE provider IN ('twilio','stt','tts','llm')) AS provider_count
             FROM ai_voice_usage_costs
            WHERE tenant_id = $1
              AND occurred_at >= $2
              AND occurred_at < $3
            GROUP BY session_id
         )
         SELECT COALESCE(SUM(usage_seconds), 0)::text AS usage_seconds,
                COALESCE(SUM(provider_cost_micro_cents), 0)::text AS provider_cost_micro_cents,
                COALESCE((SELECT ARRAY_AGG(DISTINCT provider) FROM ai_voice_usage_costs
                           WHERE tenant_id = $1 AND occurred_at >= $2 AND occurred_at < $3),
                         ARRAY[]::text[]) AS providers,
                COUNT(*) FILTER (WHERE provider_count < 4)::text AS incomplete_session_count
           FROM per_session`,
        [tenantId, periodStart, periodEnd],
      );
      return {
        usageSeconds: Number(result.rows[0]?.usage_seconds ?? 0),
        providerCostMicroCents: Number(
          result.rows[0]?.provider_cost_micro_cents ?? 0,
        ),
        providers: result.rows[0]?.providers ?? [],
        incompleteSessionCount: Number(
          result.rows[0]?.incomplete_session_count ?? 0,
        ),
      };
    });
  }

  async queueTwilioReconciliation(
    input: TwilioReconciliationInput,
  ): Promise<string> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO ai_voice_cost_reconciliation
           (id, tenant_id, session_id, call_sid, account_sid, usage_seconds,
            media_streams_used, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, session_id) DO UPDATE
           SET call_sid = EXCLUDED.call_sid,
               account_sid = EXCLUDED.account_sid,
               usage_seconds = EXCLUDED.usage_seconds,
               media_streams_used = EXCLUDED.media_streams_used,
               occurred_at = EXCLUDED.occurred_at,
               updated_at = NOW()
         RETURNING id`,
        [
          input.id,
          input.tenantId,
          input.sessionId,
          input.callSid,
          input.accountSid,
          input.usageSeconds,
          input.mediaStreamsUsed,
          input.occurredAt,
        ],
      );
      return result.rows[0]!.id;
    });
  }

  async findDueTwilio(
    tenantId: string,
    now: Date,
    limit = 25,
  ): Promise<TwilioReconciliationRow[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM ai_voice_cost_reconciliation
          WHERE tenant_id = $1 AND status = 'pending' AND next_attempt_at <= $2
          ORDER BY next_attempt_at ASC LIMIT $3`,
        [tenantId, now, limit],
      );
      return result.rows.map((row) => ({
        id: row.id as string,
        tenantId: row.tenant_id as string,
        sessionId: row.session_id as string,
        callSid: row.call_sid as string,
        accountSid: row.account_sid as string,
        usageSeconds: Number(row.usage_seconds),
        mediaStreamsUsed: Boolean(row.media_streams_used),
        occurredAt: new Date(row.occurred_at as string),
        attempts: Number(row.attempts),
      }));
    });
  }

  async completeTwilio(tenantId: string, id: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE ai_voice_cost_reconciliation SET status='completed', updated_at=NOW()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, id],
      );
    });
  }

  async deferTwilio(
    tenantId: string,
    id: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE ai_voice_cost_reconciliation
            SET attempts=attempts+1, last_error=$3, next_attempt_at=$4, updated_at=NOW()
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, id, error.slice(0, 500), nextAttemptAt],
      );
    });
  }
}
