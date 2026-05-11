import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { CallOutcome } from './voice-service';
import {
  CreateVoiceSessionInput,
  ListVoiceSessionsOptions,
  MarkVoiceSessionEndedInput,
  VoiceSessionChannel,
  VoiceSessionRepository,
  VoiceSessionRow,
} from './voice-session';

function mapRow(row: Record<string, unknown>): VoiceSessionRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    channel: row.channel as VoiceSessionChannel,
    ...(row.call_sid != null ? { callSid: row.call_sid as string } : {}),
    state: row.state as string,
    startedAt: new Date(row.started_at as string),
    ...(row.ended_at != null ? { endedAt: new Date(row.ended_at as string) } : {}),
    ...(row.ended_reason != null ? { endedReason: row.ended_reason as string } : {}),
    ...(row.outcome != null ? { outcome: row.outcome as CallOutcome } : {}),
    ...(row.transcript != null ? { transcript: row.transcript as string[] } : {}),
    ...(row.customer_id != null ? { customerId: row.customer_id as string } : {}),
  };
}

export class PgVoiceSessionRepository
  extends PgBaseRepository
  implements VoiceSessionRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async create(input: CreateVoiceSessionInput): Promise<VoiceSessionRow> {
    return this.withTenant(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO voice_sessions (id, tenant_id, channel, call_sid, customer_id, state, context, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, NOW())
         RETURNING *`,
        [
          input.id,
          input.tenantId,
          input.channel,
          input.callSid ?? null,
          input.customerId ?? null,
          input.state,
        ],
      );
      return mapRow(result.rows[0]);
    });
  }

  async markEnded(
    tenantId: string,
    id: string,
    input: MarkVoiceSessionEndedInput,
  ): Promise<VoiceSessionRow | null> {
    return this.withTenant(tenantId, async (client) => {
      // Upsert so a fire-and-forget `create()` that hasn't committed
      // (or that failed transiently) doesn't drop the terminal stamp.
      // ON CONFLICT updates iff the row is still open; the WHERE on the
      // DO UPDATE clause makes a duplicate finalize a no-op (RETURNING
      // returns zero rows → null → caller treats it as already-stamped).
      const transcriptJson =
        input.transcript !== undefined ? JSON.stringify(input.transcript) : null;
      const result = await client.query(
        `INSERT INTO voice_sessions
            (id, tenant_id, channel, call_sid, customer_id, state, context, started_at,
             ended_at, ended_reason, outcome, transcript)
          VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, NOW(), $7, $8, $9,
                  $10::jsonb)
          ON CONFLICT (id) DO UPDATE
             SET state        = EXCLUDED.state,
                 ended_at     = EXCLUDED.ended_at,
                 ended_reason = EXCLUDED.ended_reason,
                 outcome      = EXCLUDED.outcome,
                 transcript   = COALESCE(EXCLUDED.transcript, voice_sessions.transcript),
                 customer_id  = COALESCE(EXCLUDED.customer_id, voice_sessions.customer_id),
                 updated_at   = NOW()
           WHERE voice_sessions.tenant_id = EXCLUDED.tenant_id
             AND voice_sessions.ended_at IS NULL
          RETURNING *`,
        [
          id,
          tenantId,
          input.channel,
          input.callSid ?? null,
          input.customerId ?? null,
          input.state,
          input.endedAt,
          input.endedReason,
          input.outcome,
          transcriptJson,
        ],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findById(tenantId: string, id: string): Promise<VoiceSessionRow | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM voice_sessions WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      if (result.rows.length === 0) return null;
      return mapRow(result.rows[0]);
    });
  }

  async findByTenant(tenantId: string, opts: ListVoiceSessionsOptions = {}): Promise<VoiceSessionRow[]> {
    const { limit = 50, offset = 0, endedOnly, customerId } = opts;
    return this.withTenant(tenantId, async (client) => {
      const conditions: string[] = ['vs.tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (endedOnly) {
        conditions.push(`vs.ended_at IS NOT NULL`);
      }
      if (customerId) {
        conditions.push(`vs.customer_id = $${idx}`);
        params.push(customerId);
        idx++;
      }

      params.push(limit);
      params.push(offset);

      const result = await client.query(
        `SELECT vs.*
         FROM voice_sessions vs
         WHERE ${conditions.join(' AND ')}
         ORDER BY vs.started_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        params,
      );
      return result.rows.map(mapRow);
    });
  }
}
