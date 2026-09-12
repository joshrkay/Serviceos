/**
 * call_transcript_turns — per-turn rows of inbound voice conversations.
 *
 * Captures the in-memory FSM transcript (`VoiceSessionStore.transcript`)
 * to disk before the 30-min idle reaper drops it. Each row is one
 * spoken turn — agent or caller — keyed to the parent voice_recording
 * by an ordered turn_index.
 *
 * Two writers, two keys (plan U8, R8):
 *
 *   1. Mid-call: `VoiceSessionStore.appendTranscript` persists each turn
 *      as it happens, keyed by `(tenant_id, call_sid, session_id,
 *      turn_index)`. The `voice_recordings` row does not exist yet (Twilio
 *      creates it via the recording webhook after hangup), so
 *      `voice_recording_id` is NULL on these rows. A second session can be
 *      created for the same CallSid (gather-fallback after a restart,
 *      Twilio re-delivery after a reap) and restarts its index at 0, so
 *      the key must include `session_id` or the second leg would
 *      overwrite the first.
 *
 *   2. End of call: the recording webhook's `onPersisted` hook calls
 *      `attachRecording`, which points this call's unattached rows at the
 *      new recording and renumbers them into a single 0-based sequence
 *      across legs; the transcript-ingestion-worker then upserts by
 *      `(voice_recording_id, turn_index)` using the index each row already
 *      carries, so end-of-call ingestion updates the same rows it
 *      persisted mid-call and never fights over numbering.
 *
 * `speaker='caller'` rows are RIVET I13 untrusted content — classify via
 * ai/content-provenance.ts before quoting turn text into any
 * operator-facing prompt.
 *
 * Idempotency: (voice_recording_id, turn_index) is UNIQUE, and so is the
 * partial (tenant_id, call_sid, session_id, turn_index) WHERE call_sid IS
 * NOT NULL. Re-emission of the same turn (worker retry, interim→final)
 * collides cleanly; `recordTurn` uses ON CONFLICT DO UPDATE so the latest
 * text wins.
 */

import { randomUUID } from 'crypto';

export type CallTurnSpeaker = 'agent' | 'caller';

export interface CallTranscriptTurn {
  id: string;
  tenantId: string;
  /**
   * Set once the row is attached to a recording (or written directly by the
   * ingestion worker). Undefined for turns persisted mid-call that no
   * recording webhook has claimed yet.
   */
  voiceRecordingId?: string;
  /** Mid-call key: Twilio CallSid + the VoiceSessionStore session id. */
  callSid?: string;
  sessionId?: string;
  turnIndex: number;
  speaker: CallTurnSpeaker;
  text: string;
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface RecordTurnInput {
  tenantId: string;
  /** Exactly one of `voiceRecordingId` or `callSid`+`sessionId` must be set. */
  voiceRecordingId?: string;
  callSid?: string;
  sessionId?: string;
  turnIndex: number;
  speaker: CallTurnSpeaker;
  text: string;
  /** Defaults to NOW() at the database. Pass for replay/backfill. */
  startedAt?: Date;
  completedAt?: Date;
}

export interface CallTranscriptTurnRepository {
  /**
   * Insert or update a turn. Conflicts on the row's key —
   * (voice_recording_id, turn_index) or (tenant_id, call_sid, session_id,
   * turn_index) — overwrite text + completedAt (latest interim → final
   * replacement).
   */
  recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn>;

  /**
   * Return all turns for a recording in ascending turn_index order.
   * Used by the transcript-ingestion-worker (Phase 4a) and by replay
   * tooling.
   */
  listByRecording(tenantId: string, voiceRecordingId: string): Promise<CallTranscriptTurn[]>;

  /**
   * Every turn persisted for a Twilio call, across session legs, in
   * conversation order (see `sortTurnsAcrossLegs`). Attached and
   * unattached rows alike — the caller filters by `voiceRecordingId`.
   */
  listByCallSid(tenantId: string, callSid: string): Promise<CallTranscriptTurn[]>;

  /**
   * Point this call's UNATTACHED turns at `voiceRecordingId` and renumber
   * them into one 0-based sequence across session legs, atomically.
   * First-writer-wins: rows already attached (the voicemail leg's second
   * recording, a late fire-and-forget write claimed by an earlier attach)
   * are never re-pointed. Returns the number of rows attached.
   */
  attachRecording(tenantId: string, callSid: string, voiceRecordingId: string): Promise<number>;
}

export function validateRecordTurnInput(input: RecordTurnInput): void {
  if (!input.tenantId) throw new Error('call_transcript_turns: tenantId is required');
  const byRecording = Boolean(input.voiceRecordingId);
  const byCall = Boolean(input.callSid) && Boolean(input.sessionId);
  const partialCallKey = !byCall && (Boolean(input.callSid) || Boolean(input.sessionId));
  if (byRecording === byCall || partialCallKey) {
    throw new Error(
      'call_transcript_turns: exactly one of voiceRecordingId or callSid+sessionId is required',
    );
  }
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

/**
 * Parse a `VoiceSessionStore.transcript` line — `"agent: hi"` /
 * `"caller: hello"` — into its speaker and text. Falls back to
 * speaker='caller' for unprefixed lines so a single odd turn doesn't drop
 * the whole transcript (and is classified as untrusted, the safe default).
 */
export function parseTranscriptLine(raw: string): { speaker: CallTurnSpeaker; text: string } {
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const prefix = raw.slice(0, colon).trim().toLowerCase();
    const text = raw.slice(colon + 1).trim();
    if (prefix === 'agent' || prefix === 'caller') {
      return { speaker: prefix, text };
    }
  }
  return { speaker: 'caller', text: raw.trim() };
}

/**
 * Conversation order for one call's turns across session legs: legs in the
 * order they first appeared (earliest `createdAt` per `sessionId`), then
 * `turnIndex` within a leg. Both repositories use this single definition
 * for `listByCallSid` and for `attachRecording`'s renumbering, so the
 * sequence the worker ingests is the sequence the rows were renumbered to.
 *
 * Ordering by leg-then-index rather than raw `createdAt` keeps two
 * fire-and-forget writes of the same leg in append order even if their
 * transactions started out of order.
 */
export function sortTurnsAcrossLegs<T extends Pick<CallTranscriptTurn, 'sessionId' | 'createdAt' | 'turnIndex'>>(
  turns: ReadonlyArray<T>,
): T[] {
  const legStart = new Map<string, number>();
  for (const t of turns) {
    const leg = t.sessionId ?? '';
    const at = t.createdAt.getTime();
    const seen = legStart.get(leg);
    if (seen === undefined || at < seen) legStart.set(leg, at);
  }
  return [...turns].sort((a, b) => {
    const legA = a.sessionId ?? '';
    const legB = b.sessionId ?? '';
    return (
      legStart.get(legA)! - legStart.get(legB)! ||
      (legA < legB ? -1 : legA > legB ? 1 : 0) ||
      a.turnIndex - b.turnIndex
    );
  });
}

export class InMemoryCallTranscriptTurnRepository implements CallTranscriptTurnRepository {
  private readonly rows: CallTranscriptTurn[] = [];
  /**
   * Strictly increasing clock for createdAt so legs written within the same
   * millisecond still order by first-seen time, as they do in Postgres
   * (transaction-start NOW() is microsecond-resolution).
   */
  private lastCreatedAtMs = 0;

  private nextCreatedAt(): Date {
    this.lastCreatedAtMs = Math.max(Date.now(), this.lastCreatedAtMs + 1);
    return new Date(this.lastCreatedAtMs);
  }

  async recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn> {
    validateRecordTurnInput(input);
    const existingIdx = this.rows.findIndex((r) =>
      input.voiceRecordingId
        ? r.voiceRecordingId === input.voiceRecordingId && r.turnIndex === input.turnIndex
        : r.tenantId === input.tenantId &&
          r.callSid === input.callSid &&
          r.sessionId === input.sessionId &&
          r.turnIndex === input.turnIndex,
    );
    const now = new Date();
    // Mirror the Pg semantics (codex P2 on PR #233): on conflict, preserve
    // the original started_at unless the caller explicitly supplied a new
    // value. interim→final replacements should not corrupt timing/order.
    const existing = existingIdx >= 0 ? this.rows[existingIdx] : null;
    const startedAt = input.startedAt ?? existing?.startedAt ?? now;
    const turn: CallTranscriptTurn = {
      id: existing ? existing.id : randomUUID(),
      tenantId: input.tenantId,
      voiceRecordingId: existing?.voiceRecordingId ?? input.voiceRecordingId,
      callSid: existing?.callSid ?? input.callSid,
      sessionId: existing?.sessionId ?? input.sessionId,
      turnIndex: input.turnIndex,
      speaker: input.speaker,
      text: input.text,
      startedAt,
      completedAt: input.completedAt,
      createdAt: existing ? existing.createdAt : this.nextCreatedAt(),
    };
    if (existing) this.rows[existingIdx] = turn;
    else this.rows.push(turn);
    return { ...turn };
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

  async listByCallSid(tenantId: string, callSid: string): Promise<CallTranscriptTurn[]> {
    return sortTurnsAcrossLegs(
      this.rows.filter((r) => r.tenantId === tenantId && r.callSid === callSid),
    ).map((r) => ({ ...r }));
  }

  async attachRecording(
    tenantId: string,
    callSid: string,
    voiceRecordingId: string,
  ): Promise<number> {
    const pending = sortTurnsAcrossLegs(
      this.rows.filter(
        (r) => r.tenantId === tenantId && r.callSid === callSid && r.voiceRecordingId === undefined,
      ),
    );
    pending.forEach((row, index) => {
      row.turnIndex = index;
      row.voiceRecordingId = voiceRecordingId;
    });
    return pending.length;
  }
}
