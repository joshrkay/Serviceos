import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import { createAuditEvent } from '../audit/audit';
import {
  CARD_NUMBER_SPLIT_REDACTED_EVENT,
  CallTranscriptTurn,
  CallTranscriptTurnRepository,
  CallTurnSpeaker,
  CallTurnTransport,
  MarkReplyAudioInput,
  RecordTurnInput,
  RedactCardNumberTurnsInput,
  ReplyUnackedReason,
  sortTurnsAcrossLegs,
  validateMarkReplyAudioInput,
  validateRecordTurnInput,
  validateRedactCardNumberTurnsInput,
} from './call-transcript-turn';

interface CallTranscriptTurnRow {
  id: string;
  tenant_id: string;
  voice_recording_id: string | null;
  call_sid: string | null;
  session_id: string | null;
  turn_index: number;
  speaker: CallTurnSpeaker;
  text: string;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  // U1 — migration 326 (all nullable; null on pre-migration rows and agent turns).
  last_word_at: Date | null;
  stt_final_at: Date | null;
  first_audio_enqueued_at: Date | null;
  first_audio_at: Date | null;
  first_audible_at: Date | null;
  reply_gap_ms: number | null;
  endpoint_delay_ms: number | null;
  reply_unacked_reason: ReplyUnackedReason | null;
  transport: CallTurnTransport | null;
}

function rowToTurn(row: CallTranscriptTurnRow): CallTranscriptTurn {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    voiceRecordingId: row.voice_recording_id ?? undefined,
    callSid: row.call_sid ?? undefined,
    sessionId: row.session_id ?? undefined,
    turnIndex: row.turn_index,
    speaker: row.speaker,
    text: row.text,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    lastWordAt: row.last_word_at ?? undefined,
    sttFinalAt: row.stt_final_at ?? undefined,
    firstAudioEnqueuedAt: row.first_audio_enqueued_at ?? undefined,
    firstAudioAt: row.first_audio_at ?? undefined,
    firstAudibleAt: row.first_audible_at ?? undefined,
    replyGapMs: row.reply_gap_ms ?? undefined,
    endpointDelayMs: row.endpoint_delay_ms ?? undefined,
    replyUnackedReason: row.reply_unacked_reason ?? undefined,
    transport: row.transport ?? undefined,
  };
}

export class PgCallTranscriptTurnRepository
  extends PgBaseRepository
  implements CallTranscriptTurnRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn> {
    validateRecordTurnInput(input);
    // Two keys, one upsert each (migration 278_call_transcript_turns_call_sid). The mid-call key conflicts
    // on the partial unique index, so its ON CONFLICT target must repeat the
    // index predicate for the planner to match it.
    const conflictTarget = input.voiceRecordingId
      ? '(voice_recording_id, turn_index)'
      : '(tenant_id, call_sid, session_id, turn_index) WHERE call_sid IS NOT NULL';
    return this.withTenantTransaction(input.tenantId, async (client) => {
      // started_at semantics, codex P2 on PR #233:
      //   - On INSERT: COALESCE($8, NOW()) so the new row is always stamped.
      //   - On CONFLICT (interim→final replacement): preserve the original
      //     started_at unless the caller explicitly supplied a new value.
      //     We test the *parameter* $8 directly here, NOT EXCLUDED.started_at,
      //     because EXCLUDED carries the COALESCE'd value (always non-null)
      //     and would otherwise overwrite the original timestamp on every
      //     retry.
      const result = await client.query<CallTranscriptTurnRow>(
        `INSERT INTO call_transcript_turns (
           tenant_id, voice_recording_id, call_sid, session_id, turn_index, speaker, text,
           started_at, completed_at,
           last_word_at, stt_final_at, endpoint_delay_ms, transport
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10, $11, $12, $13)
         ON CONFLICT ${conflictTarget} DO UPDATE SET
           text         = EXCLUDED.text,
           speaker      = EXCLUDED.speaker,
           started_at   = COALESCE($8, call_transcript_turns.started_at),
           completed_at = EXCLUDED.completed_at,
           last_word_at      = COALESCE($10, call_transcript_turns.last_word_at),
           stt_final_at      = COALESCE($11, call_transcript_turns.stt_final_at),
           endpoint_delay_ms = COALESCE($12, call_transcript_turns.endpoint_delay_ms),
           transport         = COALESCE($13, call_transcript_turns.transport)
         RETURNING *`,
        [
          input.tenantId,
          input.voiceRecordingId ?? null,
          input.callSid ?? null,
          input.sessionId ?? null,
          input.turnIndex,
          input.speaker,
          input.text,
          input.startedAt ?? null,
          input.completedAt ?? null,
          input.lastWordAt ?? null,
          input.sttFinalAt ?? null,
          input.endpointDelayMs ?? null,
          input.transport ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('call_transcript_turns: INSERT returned no row');
      return rowToTurn(row);
    });
  }

  /**
   * U1 — the reply-audio stamps. One UPDATE, by primary key when the caller
   * has the row's id (stable across `attachRecording`'s renumbering) and by
   * the mid-call key otherwise. Every column is COALESCEd so the first stamp
   * stands (a filler's `first_audible_at` is not overwritten by the real
   * frame; a redelivered stamp is a no-op). Never inserts: a zero row count is
   * the caller's signal that the row was deleted underneath it (it increments
   * `voice_reply_stamp_lost_total`).
   */
  async markReplyAudio(input: MarkReplyAudioInput): Promise<number> {
    validateMarkReplyAudioInput(input);
    // Key placeholders come last so both branches share $1..$6 and no
    // placeholder is left unused (pg cannot type an unreferenced parameter).
    const { where, keyParams } =
      input.id !== undefined
        ? { where: 'id = $7', keyParams: [input.id] }
        : {
            where: 'call_sid = $7 AND session_id = $8 AND turn_index = $9',
            keyParams: [input.callSid, input.sessionId, input.turnIndex],
          };
    return this.withTenantTransaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE call_transcript_turns SET
           first_audible_at        = COALESCE(first_audible_at, $2),
           first_audio_enqueued_at = COALESCE(first_audio_enqueued_at, $3),
           first_audio_at          = COALESCE(first_audio_at, $4),
           reply_gap_ms            = COALESCE(reply_gap_ms, $5),
           reply_unacked_reason    = COALESCE(reply_unacked_reason, $6)
         WHERE tenant_id = $1 AND ${where}`,
        [
          input.tenantId,
          input.firstAudibleAt ?? null,
          input.firstAudioEnqueuedAt ?? null,
          input.firstAudioAt ?? null,
          input.replyGapMs ?? null,
          input.replyUnackedReason ?? null,
          ...keyParams,
        ],
      );
      return result.rowCount ?? 0;
    });
  }

  async listByRecording(
    tenantId: string,
    voiceRecordingId: string,
  ): Promise<CallTranscriptTurn[]> {
    return this.withTenant(tenantId, async (client) => {
      // tenant_id explicit in the WHERE clause: defense-in-depth alongside
      // RLS, and the planner can use idx_call_transcript_turns_tenant if it
      // chooses to. Matches PgVoiceRepository.findById and the rest of the
      // codebase.
      const result = await client.query<CallTranscriptTurnRow>(
        `SELECT *
           FROM call_transcript_turns
          WHERE voice_recording_id = $1 AND tenant_id = $2
          ORDER BY turn_index ASC`,
        [voiceRecordingId, tenantId],
      );
      return result.rows.map(rowToTurn);
    });
  }

  async listByCallSid(tenantId: string, callSid: string): Promise<CallTranscriptTurn[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<CallTranscriptTurnRow>(
        `SELECT *
           FROM call_transcript_turns
          WHERE tenant_id = $1 AND call_sid = $2`,
        [tenantId, callSid],
      );
      return sortTurnsAcrossLegs(result.rows.map(rowToTurn));
    });
  }

  async attachRecording(
    tenantId: string,
    callSid: string,
    voiceRecordingId: string,
  ): Promise<number> {
    return this.withTenantTransaction(tenantId, async (client) => {
      // Lock this call's unattached rows so a concurrent attach (the
      // voicemail leg's webhook racing the call's) serialises behind us and
      // then finds nothing left to claim: first-writer-wins.
      const pending = await client.query<CallTranscriptTurnRow>(
        `SELECT *
           FROM call_transcript_turns
          WHERE tenant_id = $1 AND call_sid = $2 AND voice_recording_id IS NULL
          FOR UPDATE`,
        [tenantId, callSid],
      );
      if (pending.rows.length === 0) return 0;

      const ordered = sortTurnsAcrossLegs(pending.rows.map(rowToTurn));
      const ids = ordered.map((t) => t.id);
      const indices = ordered.map((_, index) => index);

      // Renumber in two passes. The partial unique index on (tenant_id,
      // call_sid, session_id, turn_index) is checked per row as an UPDATE
      // proceeds, so compacting a leg with a gap (0,2 → 0,1) or offsetting a
      // second leg (0,1 → 3,4) in one statement can transiently collide with
      // a not-yet-rewritten sibling. Lifting every row first makes the final
      // assignment collision-free — but only if the lifted range sits above
      // EVERY final value, not just above the current maximum. The finals
      // are 0..n-1, so the lift must exceed n-1 as well as maxIndex: with a
      // 1-turn leg followed by a 3-turn leg, maxIndex+1 (=3) lifts leg-2 to
      // 3,4,5 while its finals are 1,2,3, and the final UPDATE — which walks
      // rows in heap order, not array order — could write 5→3 before 3→1 and
      // trip the index (PR #975 review finding 1).
      const maxIndex = Math.max(...ordered.map((t) => t.turnIndex));
      const lift = maxIndex + 1 + ordered.length;
      await client.query(
        `UPDATE call_transcript_turns
            SET turn_index = turn_index + $3
          WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND voice_recording_id IS NULL`,
        [tenantId, ids, lift],
      );
      const attached = await client.query(
        `UPDATE call_transcript_turns AS t
            SET turn_index = v.turn_index,
                voice_recording_id = $4
           FROM unnest($2::uuid[], $3::int[]) AS v(id, turn_index)
          WHERE t.id = v.id AND t.tenant_id = $1 AND t.voice_recording_id IS NULL`,
        [tenantId, ids, indices, voiceRecordingId],
      );
      return attached.rowCount ?? 0;
    });
  }

  /**
   * PRIV-3 — one transaction: every contributing caller row rewritten, then
   * the audit row, so either the whole card leaves the stored call or none of
   * the rewrite lands (the in-memory transcript is already rewritten either
   * way, and the recording hook later flags the recording from it). Each row
   * is matched on this session's call key and `speaker = 'caller'` as well as
   * its id, so a stale id can never rewrite another session's or an agent's
   * row; without an id, only a row no recording has claimed (its mid-call
   * index is still the append-time one).
   */
  async redactCardNumberTurns(input: RedactCardNumberTurnsInput): Promise<number> {
    validateRedactCardNumberTurnsInput(input);
    const { tenantId, callSid, sessionId } = input;
    return this.withTenantTransaction(tenantId, async (client) => {
      const rewritten: number[] = [];
      for (const turn of input.turns) {
        const result =
          turn.id !== undefined
            ? await client.query(
                `UPDATE call_transcript_turns SET text = $5
                  WHERE tenant_id = $1 AND call_sid = $2 AND session_id = $3
                    AND speaker = 'caller' AND id = $4`,
                [tenantId, callSid, sessionId, turn.id, turn.text],
              )
            : await client.query(
                `UPDATE call_transcript_turns SET text = $5
                  WHERE tenant_id = $1 AND call_sid = $2 AND session_id = $3
                    AND speaker = 'caller' AND turn_index = $4 AND voice_recording_id IS NULL`,
                [tenantId, callSid, sessionId, turn.turnIndex, turn.text],
              );
        if ((result.rowCount ?? 0) > 0) rewritten.push(turn.turnIndex);
      }
      if (rewritten.length === 0) return 0;
      const event = createAuditEvent({
        tenantId,
        actorId: input.actorId,
        actorRole: 'system',
        eventType: CARD_NUMBER_SPLIT_REDACTED_EVENT,
        entityType: 'voice_session',
        entityId: sessionId,
        metadata: { callSid, turnIndexes: rewritten, rows: rewritten.length },
      });
      await client.query(
        `INSERT INTO audit_events
           (id, tenant_id, actor_id, actor_role, event_type, entity_type,
            entity_id, correlation_id, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          event.id,
          event.tenantId,
          event.actorId,
          event.actorRole,
          event.eventType,
          event.entityType,
          event.entityId,
          event.correlationId ?? null,
          JSON.stringify(event.metadata ?? {}),
          event.createdAt,
        ],
      );
      return rewritten.length;
    });
  }
}
