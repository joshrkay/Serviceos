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

/**
 * U1 (voice parity) — which phone transport produced a caller turn's timing
 * stamps. `null` on rows written before the stamps existed, on agent turns,
 * and on in-app sessions (no transport clock to anchor to).
 */
export const CALL_TURN_TRANSPORTS = ['gather', 'realtime'] as const;
export type CallTurnTransport = (typeof CALL_TURN_TRANSPORTS)[number];

/**
 * U1 — why a reply's first REAL frame was enqueued but never acknowledged by
 * Twilio: the mark behind it came back as a `clear` echo (barge-in flushed
 * the buffer), no ack arrived within the 5 s window, or the stream closed
 * first. Such a turn keeps `first_audio_at` / `reply_gap_ms` null — nothing is
 * estimated — but is COUNTED, so repeated playout failures cannot make the
 * reply-gap percentile look healthier.
 */
export type ReplyUnackedReason = 'clear_echo' | 'ack_timeout' | 'stream_closed';
export const REPLY_UNACKED_REASONS: ReadonlyArray<ReplyUnackedReason> = [
  'clear_echo',
  'ack_timeout',
  'stream_closed',
];

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
  /**
   * U1 reply-gap stamps (caller turns only; see migration 326). Written in two
   * steps: `recordTurn` carries what is known when the caller's text is
   * appended (STT-final), `markReplyAudio` adds what is known only once the
   * reply's audio played. `replyGapMs = firstAudioAt − lastWordAt`;
   * `endpointDelayMs = sttFinalAt − lastWordAt`.
   */
  lastWordAt?: Date;
  sttFinalAt?: Date;
  firstAudioEnqueuedAt?: Date;
  firstAudioAt?: Date;
  firstAudibleAt?: Date;
  replyGapMs?: number;
  endpointDelayMs?: number;
  replyUnackedReason?: ReplyUnackedReason;
  transport?: CallTurnTransport;
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
  /**
   * U1 — timing known at append time for a CALLER turn: when the caller
   * stopped speaking (Deepgram word timing anchored to wall clock; realtime
   * only), when the recogniser finalised (realtime: the `final` event; Gather:
   * the webhook receipt), their difference, and the transport. On a conflict
   * (interim → final replacement) a provided value wins and an absent one
   * keeps what the row already has.
   */
  lastWordAt?: Date;
  sttFinalAt?: Date;
  endpointDelayMs?: number;
  transport?: CallTurnTransport;
}

/**
 * U1 — the second write of a caller turn's reply timing, keyed on the row's id
 * when known, else on the mid-call upsert key
 * `(tenant_id, call_sid, session_id, turn_index)`. Every stamp is
 * `COALESCE`d onto the row, so a filler's `firstAudibleAt` is never overwritten
 * by the later real frame and a repeated stamp is a no-op. Returns the number
 * of rows updated: 0 means the row is gone and the caller counts a lost stamp
 * rather than inserting one.
 */
export interface MarkReplyAudioInput {
  tenantId: string;
  /**
   * The row's primary key, as `recordTurn` returned it. When set the UPDATE
   * matches on it (plus tenant) and ignores the mid-call key: `attachRecording`
   * renumbers `turn_index` at end of call, so a stamp that lands after it must
   * not chase the stale index. Absent only when the insert never resolved an
   * id; then the (callSid, sessionId, turnIndex) key is used.
   */
  id?: string;
  callSid: string;
  sessionId: string;
  turnIndex: number;
  firstAudibleAt?: Date;
  firstAudioEnqueuedAt?: Date;
  firstAudioAt?: Date;
  replyGapMs?: number;
  replyUnackedReason?: ReplyUnackedReason;
}

/**
 * PRIV-3 — the audit event written with every cross-turn card-number rewrite
 * (entity: the voice session). Its metadata carries turn indexes and counts,
 * never text.
 */
export const CARD_NUMBER_SPLIT_REDACTED_EVENT = 'voice.transcript_card_number_redacted';

/**
 * PRIV-3 — a card number a caller split across turns: the new text of each
 * of the session's caller turns that held part of it (its part replaced by
 * the marker), and of each agent turn between them that repeated a part
 * (the confirm readback). A row is addressed by primary key when `recordTurn`
 * resolved one (stable across `attachRecording`'s renumbering), else by the
 * mid-call key on a row no recording has claimed yet, and always by its
 * speaker (`speaker`, a caller turn when absent).
 */
export interface RedactCardNumberTurnsInput {
  tenantId: string;
  callSid: string;
  sessionId: string;
  /** Who rewrote them, for the audit row: the live store, or the recording hook. */
  actorId: string;
  turns: ReadonlyArray<{ id?: string; turnIndex: number; speaker?: CallTurnSpeaker; text: string }>;
}

export interface CallTranscriptTurnRepository {
  /**
   * Insert or update a turn. Conflicts on the row's key —
   * (voice_recording_id, turn_index) or (tenant_id, call_sid, session_id,
   * turn_index) — overwrite text + completedAt (latest interim → final
   * replacement).
   */
  recordTurn(input: RecordTurnInput): Promise<CallTranscriptTurn>;

  /** U1 — see {@link MarkReplyAudioInput}. Never inserts. */
  markReplyAudio(input: MarkReplyAudioInput): Promise<number>;

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

  /**
   * PRIV-3 — rewrite the text of the turns that held a card number split
   * across turns (and the agent's lines that repeated a part of it), all of
   * them in ONE transaction together with one
   * {@link CARD_NUMBER_SPLIT_REDACTED_EVENT} audit row, so the stored call
   * never keeps part of the card. Only this session's rows of the speaker
   * each turn names are touched. Returns the number of rows rewritten.
   */
  redactCardNumberTurns(input: RedactCardNumberTurnsInput): Promise<number>;
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
  if (input.transport !== undefined && !CALL_TURN_TRANSPORTS.includes(input.transport)) {
    throw new Error(`call_transcript_turns: transport must be 'gather' or 'realtime' (got ${input.transport})`);
  }
}

export function validateMarkReplyAudioInput(input: MarkReplyAudioInput): void {
  if (!input.tenantId) throw new Error('call_transcript_turns: tenantId is required');
  if (!input.callSid || !input.sessionId) {
    throw new Error('call_transcript_turns: markReplyAudio needs callSid and sessionId');
  }
  if (!Number.isInteger(input.turnIndex) || input.turnIndex < 0) {
    throw new Error('call_transcript_turns: turnIndex must be a non-negative integer');
  }
  if (
    input.replyUnackedReason !== undefined &&
    !REPLY_UNACKED_REASONS.includes(input.replyUnackedReason)
  ) {
    throw new Error(
      `call_transcript_turns: unknown replyUnackedReason ${String(input.replyUnackedReason)}`,
    );
  }
}

export function validateRedactCardNumberTurnsInput(input: RedactCardNumberTurnsInput): void {
  if (!input.tenantId) throw new Error('call_transcript_turns: tenantId is required');
  if (!input.callSid || !input.sessionId || !input.actorId) {
    throw new Error('call_transcript_turns: redactCardNumberTurns needs callSid, sessionId and actorId');
  }
  if (input.turns.length === 0) {
    throw new Error('call_transcript_turns: redactCardNumberTurns needs at least one turn');
  }
  for (const turn of input.turns) {
    if (!Number.isInteger(turn.turnIndex) || turn.turnIndex < 0) {
      throw new Error('call_transcript_turns: turnIndex must be a non-negative integer');
    }
    if (turn.text.length === 0) throw new Error('call_transcript_turns: text must be non-empty');
    if (turn.speaker !== undefined && turn.speaker !== 'caller' && turn.speaker !== 'agent') {
      throw new Error('call_transcript_turns: speaker must be caller or agent');
    }
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
      // U1 — a provided stamp wins, an absent one keeps the row's (Pg COALESCE).
      lastWordAt: input.lastWordAt ?? existing?.lastWordAt,
      sttFinalAt: input.sttFinalAt ?? existing?.sttFinalAt,
      endpointDelayMs: input.endpointDelayMs ?? existing?.endpointDelayMs,
      transport: input.transport ?? existing?.transport,
      firstAudioEnqueuedAt: existing?.firstAudioEnqueuedAt,
      firstAudioAt: existing?.firstAudioAt,
      firstAudibleAt: existing?.firstAudibleAt,
      replyGapMs: existing?.replyGapMs,
      replyUnackedReason: existing?.replyUnackedReason,
    };
    if (existing) this.rows[existingIdx] = turn;
    else this.rows.push(turn);
    return { ...turn };
  }

  async markReplyAudio(input: MarkReplyAudioInput): Promise<number> {
    validateMarkReplyAudioInput(input);
    const row = this.rows.find((r) =>
      input.id
        ? r.tenantId === input.tenantId && r.id === input.id
        : r.tenantId === input.tenantId &&
          r.callSid === input.callSid &&
          r.sessionId === input.sessionId &&
          r.turnIndex === input.turnIndex,
    );
    if (!row) return 0;
    // COALESCE: the first stamp of each column stands (a filler's
    // first_audible_at survives the real frame; a repeat is a no-op).
    row.firstAudibleAt = row.firstAudibleAt ?? input.firstAudibleAt;
    row.firstAudioEnqueuedAt = row.firstAudioEnqueuedAt ?? input.firstAudioEnqueuedAt;
    row.firstAudioAt = row.firstAudioAt ?? input.firstAudioAt;
    row.replyGapMs = row.replyGapMs ?? input.replyGapMs;
    row.replyUnackedReason = row.replyUnackedReason ?? input.replyUnackedReason;
    return 1;
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

  async redactCardNumberTurns(input: RedactCardNumberTurnsInput): Promise<number> {
    validateRedactCardNumberTurnsInput(input);
    let rewritten = 0;
    for (const turn of input.turns) {
      const row = this.rows.find(
        (r) =>
          r.tenantId === input.tenantId &&
          r.callSid === input.callSid &&
          r.sessionId === input.sessionId &&
          r.speaker === (turn.speaker ?? 'caller') &&
          (turn.id !== undefined
            ? r.id === turn.id
            : r.turnIndex === turn.turnIndex && r.voiceRecordingId === undefined),
      );
      if (!row) continue;
      row.text = turn.text;
      rewritten++;
    }
    return rewritten;
  }
}
