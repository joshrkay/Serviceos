/**
 * Read-only Postgres `UtteranceSource` for the TypeSafe frustration spike.
 *
 * Reads `call_transcript_turns` (caller speech) and `audit_events` rows written
 * by the calling FSM's `audit_log` side-effect (`agent.calling.<state>.
 * keyword_frustration | llm_sentiment`, entity_type 'voice_session', entity_id
 * = voice session id, metadata.ts = epoch ms).
 *
 * Safety: every read runs in a `BEGIN READ ONLY` transaction with the tenant
 * GUC set transaction-locally, so RLS applies and nothing can be written even
 * by a bug here. Point it at staging or a replica, never a primary.
 */
import type {
  CallerTurn,
  FrustrationEvent,
  UtteranceSource,
  WindowQuery,
} from './extract-utterances';

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

const TURNS_SQL = `
  SELECT tenant_id, call_sid, session_id, turn_index, text,
         (EXTRACT(EPOCH FROM COALESCE(started_at, created_at)) * 1000)::bigint AS at
    FROM call_transcript_turns
   WHERE tenant_id = $1
     AND speaker = 'caller'
     AND session_id IS NOT NULL
     AND COALESCE(started_at, created_at) >= to_timestamp($2::double precision / 1000.0)
     AND COALESCE(started_at, created_at) <  to_timestamp($3::double precision / 1000.0)
   ORDER BY COALESCE(started_at, created_at), turn_index`;

const EVENTS_SQL = `
  SELECT tenant_id, entity_id AS session_id, event_type,
         COALESCE(metadata->>'callSid', '') AS call_sid,
         COALESCE(
           CASE WHEN metadata->>'ts' ~ '^[0-9]{10,}$' THEN (metadata->>'ts')::bigint END,
           (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
         ) AS at
    FROM audit_events
   WHERE tenant_id = $1
     AND entity_type = 'voice_session'
     AND (event_type LIKE 'agent.calling.%.keyword_frustration'
       OR event_type LIKE 'agent.calling.%.llm_sentiment')
     AND created_at >= to_timestamp($2::double precision / 1000.0)
     AND created_at <  to_timestamp($3::double precision / 1000.0)
   ORDER BY created_at`;

export class PgUtteranceSource implements UtteranceSource {
  constructor(private readonly pool: PgPoolLike) {}

  private async readOnly<T>(
    tenantId: string,
    sql: string,
    q: WindowQuery
  ): Promise<Record<string, unknown>[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const { rows } = await client.query(sql, [tenantId, q.from, q.to]);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listCallerTurns(q: WindowQuery): Promise<CallerTurn[]> {
    const rows = await this.readOnly(q.tenantId, TURNS_SQL, q);
    return rows.map((r) => ({
      tenantId: String(r.tenant_id),
      callSid: r.call_sid == null ? '' : String(r.call_sid),
      sessionId: String(r.session_id),
      turnIndex: Number(r.turn_index),
      text: String(r.text),
      at: Number(r.at),
    }));
  }

  async listFrustrationEvents(q: WindowQuery): Promise<FrustrationEvent[]> {
    const rows = await this.readOnly(q.tenantId, EVENTS_SQL, q);
    return rows.map((r) => ({
      tenantId: String(r.tenant_id),
      callSid: String(r.call_sid ?? ''),
      sessionId: String(r.session_id),
      source: String(r.event_type).endsWith('.keyword_frustration') ? 'keyword' : 'llm_sentiment',
      at: Number(r.at),
    }));
  }
}
