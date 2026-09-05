import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CallTranscriptTurn,
  CallTranscriptTurnRepository,
  CallTurnSpeaker,
  RecordTurnInput,
  sortTurnsAcrossLegs,
  validateRecordTurnInput,
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
    // Two keys, one upsert each (migration 274). The mid-call key conflicts
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
           started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9)
         ON CONFLICT ${conflictTarget} DO UPDATE SET
           text         = EXCLUDED.text,
           speaker      = EXCLUDED.speaker,
           started_at   = COALESCE($8, call_transcript_turns.started_at),
           completed_at = EXCLUDED.completed_at
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
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('call_transcript_turns: INSERT returned no row');
      return rowToTurn(row);
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
}
