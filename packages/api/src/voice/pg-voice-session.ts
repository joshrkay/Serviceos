import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import type { CallOutcome } from './voice-service';
import {
  CreateVoiceSessionInput,
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
        `INSERT INTO voice_sessions (id, tenant_id, channel, call_sid, state, context, started_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, NOW())
         RETURNING *`,
        [input.id, input.tenantId, input.channel, input.callSid ?? null, input.state],
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
      const result = await client.query(
        `UPDATE voice_sessions
            SET ended_at     = $1,
                ended_reason = $2,
                outcome      = $3,
                updated_at   = NOW()
          WHERE id = $4 AND tenant_id = $5 AND ended_at IS NULL
          RETURNING *`,
        [input.endedAt, input.endedReason, input.outcome, id, tenantId],
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
}
