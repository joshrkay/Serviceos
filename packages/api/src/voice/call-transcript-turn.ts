/**
 * call_transcript_turns — per-turn rows of inbound voice conversations.
 *
 * Captures the in-memory FSM transcript (`VoiceSessionStore.transcript`)
 * to disk before the 30-min idle reaper drops it. Each row is one
 * spoken turn — agent or caller — keyed to the parent voice_recording
 * by an ordered turn_index.
 *
 * Phase 2 of the inbound-CSR training-data architecture: write surface
 * exists but no caller in main writes it yet. The transcript-ingestion-
 * worker (Phase 4a) will hook the FSM `end_session` side effect to
 * flush turns here, and the per-call-summary + rolling-window chunks
 * built by that worker will read from this table.
 *
 * Idempotency: (voice_recording_id, turn_index) is UNIQUE in the
 * schema. Re-emission of the same turn (e.g., worker retry) collides
 * cleanly. Repository's `recordTurn` uses ON CONFLICT DO UPDATE so the
 * latest text wins — useful when a final transcript replaces an
 * interim one.
 */

import { randomUUID } from 'crypto';

export type CallTurnSpeaker = 'agent' | 'caller';

export interface CallTranscriptTurn {
  id: string;
  tenantId: string;
  voiceRecordingId: string;
  turnIndex: number;
  speaker: CallTurnSpeaker;
  text: string;
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface RecordTurnInput {
  tenantId: string;
  voiceRecordingId: string;
  turnIndex: number;
  speaker: CallTurnSpeaker;
  text: string;
  /** Defaults to NOW() at the database. Pass for replay/backfill. */
  startedAt?: Date;
  completedAt?: Date;
}

export interface CallTranscriptTurnRepository {
  /**
   * Insert or update a turn. Conflicts on (voice_recording_id, turn_index)
   * overwrite text + completedAt (latest interim → final replacement).
   */
  recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn>;

  /**
   * Return all turns for a recording in ascending turn_index order.
   * Used by the transcript-ingestion-worker (Phase 4a) and by replay
   * tooling.
   */
  listByRecording(tenantId: string, voiceRecordingId: string): Promise<CallTranscriptTurn[]>;
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

export class InMemoryCallTranscriptTurnRepository implements CallTranscriptTurnRepository {
  private readonly rows: CallTranscriptTurn[] = [];

  async recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn> {
    validateInput(input);
    const existingIdx = this.rows.findIndex(
      (r) => r.voiceRecordingId === input.voiceRecordingId && r.turnIndex === input.turnIndex,
    );
    const now = new Date();
    const startedAt = input.startedAt ?? now;
    const turn: CallTranscriptTurn = {
      id: existingIdx >= 0 ? this.rows[existingIdx].id : randomUUID(),
      tenantId: input.tenantId,
      voiceRecordingId: input.voiceRecordingId,
      turnIndex: input.turnIndex,
      speaker: input.speaker,
      text: input.text,
      startedAt,
      completedAt: input.completedAt,
      createdAt: existingIdx >= 0 ? this.rows[existingIdx].createdAt : now,
    };
    if (existingIdx >= 0) this.rows[existingIdx] = turn;
    else this.rows.push(turn);
    return turn;
  }

  async listByRecording(
    tenantId: string,
    voiceRecordingId: string,
  ): Promise<CallTranscriptTurn[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.voiceRecordingId === voiceRecordingId)
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((r) => ({ ...r }));
  }
}
