import { Pool } from 'pg';
import { PgBaseRepository } from '../db/pg-base';
import {
  CallTranscriptTurn,
  CallTranscriptTurnRepository,
  CallTurnSpeaker,
  RecordTurnInput,
} from './call-transcript-turn';

interface CallTranscriptTurnRow {
  id: string;
  tenant_id: string;
  voice_recording_id: string;
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
    voiceRecordingId: row.voice_recording_id,
    turnIndex: row.turn_index,
    speaker: row.speaker,
    text: row.text,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  };
}

function validateInput(input: RecordTurnInput): void {
  if (!input.tenantId) throw new Error('call_transcript_turns: tenantId is required');
  if (!input.voiceRecordingId) throw new Error('call_transcript_turns: voiceRecordingId is required');
  if (!Number.isInteger(input.turnIndex) || input.turnIndex < 0) {
    throw new Error('call_transcript_turns: turnIndex must be a non-negative integer');
  }
  if (input.speaker !== 'agent' && input.speaker !== 'caller') {
    throw new Error(`call_transcript_turns: speaker must be 'agent' or 'caller' (got ${input.speaker})`);
  }
  if (input.text.length === 0) {
    throw new Error('call_transcript_turns: text must be non-empty');
  }
}

export class PgCallTranscriptTurnRepository
  extends PgBaseRepository
  implements CallTranscriptTurnRepository
{
  constructor(pool: Pool) {
    super(pool);
  }

  async recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn> {
    validateInput(input);
    return this.withTenantTransaction(input.tenantId, async (client) => {
      // started_at semantics, codex P2 on PR #233:
      //   - On INSERT: COALESCE($6, NOW()) so the new row is always stamped.
      //   - On CONFLICT (interim→final replacement): preserve the original
      //     started_at unless the caller explicitly supplied a new value.
      //     We test the *parameter* $6 directly here, NOT EXCLUDED.started_at,
      //     because EXCLUDED carries the COALESCE'd value (always non-null)
      //     and would otherwise overwrite the original timestamp on every
      //     retry.
      const result = await client.query<CallTranscriptTurnRow>(
        `INSERT INTO call_transcript_turns (
           tenant_id, voice_recording_id, turn_index, speaker, text, started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), $7)
         ON CONFLICT (voice_recording_id, turn_index) DO UPDATE SET
           text         = EXCLUDED.text,
           speaker      = EXCLUDED.speaker,
           started_at   = COALESCE($6, call_transcript_turns.started_at),
           completed_at = EXCLUDED.completed_at
         RETURNING *`,
        [
          input.tenantId,
          input.voiceRecordingId,
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
}
