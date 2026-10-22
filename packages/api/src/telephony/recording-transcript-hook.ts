/**
 * Recording webhook → transcript durability hook (plan U8, R8).
 *
 * Wired by app.ts as `createRecordingRouter`'s `options.onPersisted`. Runs
 * once per freshly-inserted voice_recordings row (Twilio retries arrive
 * with `inserted=false` and are skipped — the first delivery already did
 * this work):
 *
 *   1. `attachRecording` — claim the turns VoiceSessionStore persisted
 *      mid-call for this CallSid, renumber them across session legs, point
 *      them at the new recording. First-writer-wins, so the voicemail
 *      leg's second recording never steals the call's turns.
 *   2. Build the ingestion payload from the persisted rows (their indices
 *      are the renumbered ones the worker must upsert onto) unless the
 *      in-memory session — ended or not — still holds MORE lines than were
 *      persisted: a fire-and-forget persist that failed or is in flight
 *      must not shrink the transcript while the full one is in memory. The
 *      session is also the fallback when nothing was persisted at all.
 *      Turns an earlier recording of the same call already claimed are
 *      never re-ingested under a later one, session or not.
 *   3. Enqueue `transcript_ingestion` when the worker is registered
 *      (`queue` present ⇔ an embedding provider is wired). Attach and the
 *      audit below never depend on it.
 *   4. When neither persisted rows nor a session exist, the transcript is
 *      genuinely gone: emit audit `voice.transcript_unrecoverable` so the
 *      loss is visible instead of silent.
 *   5. PRIV-3 — when a caller turn carries the `[card number]` marker (a card
 *      was recited; `callerTranscriptText` replaced the digits), flag the
 *      recording `pci_detected` so the retention sweep deletes its audio
 *      promptly. Runs whether or not the ingestion worker is registered.
 *   6. PRIV-3 — before any of that, the stored rows are cleared of a card
 *      number the caller split across turns. The live rewrite of those rows
 *      is fire-and-forget, so one that failed or has not landed yet would
 *      leave the fragments for ingestion, where knowledge_chunks' per-chunk
 *      scrub cannot see a card spread over several "caller:" lines. The
 *      session's in-flight rewrites are awaited and the ones that did not
 *      land are written (`writeUnwrittenCardRedactions`), then the rows are
 *      read again in the live window (`redactSplitCardNumbers`).
 *
 * Failure-soft throughout — the recording is already on disk by the time
 * this runs, and the router 200s Twilio regardless.
 */
import type { VoiceSession, VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import type { Queue } from '../queues/queue';
import { containsCardNumber, redactCardNumbersInCallTurns } from '../ai/privacy/pan-redact';
import { flagCardNumberRecording } from '../voice/card-number-recording';
import type { VoiceRepository } from '../voice/voice-service';
import {
  parseTranscriptLine,
  type CallTranscriptTurn,
  type CallTranscriptTurnRepository,
} from '../voice/call-transcript-turn';
import type {
  TranscriptIngestionPayload,
  TranscriptIngestionTurn,
} from '../workers/transcript-ingestion-worker';
import type { RecordingPersistedEvent } from './recording-webhook';

export interface RecordingTranscriptHookDeps {
  store: Pick<VoiceSessionStore, 'findByCallSidIncludingEnded'>;
  callTranscriptTurnRepo: Pick<
    CallTranscriptTurnRepository,
    'attachRecording' | 'listByCallSid' | 'redactCardNumberTurns'
  >;
  /** PRIV-3 — flags a recording whose transcript carries a card number. */
  voiceRepo: Pick<VoiceRepository, 'markCardNumberDetected'>;
  auditRepo: Pick<AuditRepository, 'create'>;
  /** Omit when no transcript-ingestion worker is registered (no embedding provider). */
  queue?: Pick<Queue, 'send'>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export const TRANSCRIPT_UNRECOVERABLE_EVENT = 'voice.transcript_unrecoverable';

const CARD_REWRITE_FAILED = 'recording-transcript-hook: card-number rewrite of stored turns failed';

/**
 * PRIV-3 — the session's cross-turn card rewrites of its stored rows that
 * did not land. The completing turn was stored already rewritten, so the
 * fragments left in the earlier rows ("my card is 4111 1111", "1111") no
 * longer read as a card: no re-read of the rows can find them, only the
 * session knows what they must say. Its in-flight rewrites are awaited first
 * (they land, or fail and join the list), then each unwritten one is written
 * in its audited transaction. Returns row id → text for every row they name,
 * landed or not, so the ingested text is the redacted one either way; a
 * failed write is logged (indexes only, never text) and kept.
 */
async function writeUnwrittenCardRedactions(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: { tenantId: string; callSid: string; voiceRecordingId: string },
  session: VoiceSession,
): Promise<Map<string, string>> {
  await session.cardRedactionWrites;
  const texts = new Map<string, string>();
  for (const turns of session.unwrittenCardRedactions.splice(0)) {
    for (const turn of turns) if (turn.id) texts.set(turn.id, turn.text);
    try {
      await deps.callTranscriptTurnRepo.redactCardNumberTurns({
        tenantId: ids.tenantId,
        callSid: ids.callSid,
        sessionId: session.id,
        actorId: 'recording_webhook',
        turns,
      });
    } catch (err) {
      session.unwrittenCardRedactions.push(turns);
      deps.logger.error(CARD_REWRITE_FAILED, {
        callSid: ids.callSid,
        voiceRecordingId: ids.voiceRecordingId,
        sessionId: session.id,
        turnIndexes: turns.map((t) => t.turnIndex),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return texts;
}

/**
 * PRIV-3 — a card number a caller split across turns whose every part is
 * still digits in this recording's stored rows (no live rewrite ever saw it:
 * rows from a process without the stitching). Each session leg's caller rows
 * are read again exactly as the live path reads them
 * (`redactCardNumbersInCallTurns`: the same window, by the time each row
 * was stored, with the agent's rows around it as context; agent rows are
 * never rewritten), and every row that held part of a card is rewritten in one
 * audited transaction per leg (`redactCardNumberTurns`). Returns the rows as
 * they now read; a failed write is logged (indexes only, never text) and the
 * rewritten text is still what is ingested.
 */
async function redactSplitCardNumbers(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: { tenantId: string; callSid: string; voiceRecordingId: string },
  rows: CallTranscriptTurn[],
): Promise<CallTranscriptTurn[]> {
  const legs = new Map<string, CallTranscriptTurn[]>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    legs.set(row.sessionId, [...(legs.get(row.sessionId) ?? []), row]);
  }
  const rewritten = new Map<string, string>();
  for (const [sessionId, legRows] of legs) {
    const texts = redactCardNumbersInCallTurns(
      legRows.map((row) => ({ speaker: row.speaker, text: row.text, at: row.startedAt.getTime() })),
    );
    if (!texts) continue;
    const turns = legRows.flatMap((row, k) =>
      texts[k] === row.text ? [] : [{ id: row.id, turnIndex: row.turnIndex, text: texts[k] }],
    );
    for (const turn of turns) rewritten.set(turn.id, turn.text);
    try {
      await deps.callTranscriptTurnRepo.redactCardNumberTurns({
        tenantId: ids.tenantId,
        callSid: ids.callSid,
        sessionId,
        actorId: 'recording_webhook',
        turns,
      });
    } catch (err) {
      deps.logger.error(CARD_REWRITE_FAILED, {
        callSid: ids.callSid,
        voiceRecordingId: ids.voiceRecordingId,
        sessionId,
        turnIndexes: turns.map((t) => t.turnIndex),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows.map((row) => {
    const text = rewritten.get(row.id);
    return text === undefined ? row : { ...row, text };
  });
}

export function createRecordingTranscriptHook(
  deps: RecordingTranscriptHookDeps,
): (event: RecordingPersistedEvent) => Promise<void> {
  const { store, callTranscriptTurnRepo, voiceRepo, auditRepo, queue, logger } = deps;

  return async (event) => {
    if (!event.inserted) return;
    const { tenantId, callSid, voiceRecordingId } = event;

    // Ended-inclusive lookup: by the time Twilio's recording webhook fires,
    // the FSM has terminated and `ended === true` on every normal hangup
    // path (precedent: TwilioGatherAdapter#stampCallOutcomeByCallSid).
    // The store is keyed by CallSid alone, while the webhook resolves its
    // tenant independently (live session, else phone-number lookup, else
    // TWILIO_DEFAULT_TENANT_ID). If the two disagree, the session's transcript
    // belongs to ANOTHER tenant and must never be ingested under this one —
    // treat it as absent and let the persisted-rows / unrecoverable paths run.
    let session = store.findByCallSidIncludingEnded(callSid);
    if (session && session.tenantId !== tenantId) {
      logger.warn('recording-transcript-hook: session tenant differs from webhook tenant — ignoring session transcript', {
        callSid,
        voiceRecordingId,
        webhookTenantId: tenantId,
        sessionTenantId: session.tenantId,
      });
      session = undefined;
    }

    // PRIV-3 — the session's card rewrites of its rows that did not land.
    const unwritten = session
      ? await writeUnwrittenCardRedactions(
          { callTranscriptTurnRepo, logger },
          { tenantId, callSid, voiceRecordingId },
          session,
        )
      : new Map<string, string>();

    let persistedForCall: Awaited<ReturnType<CallTranscriptTurnRepository['listByCallSid']>> = [];
    try {
      await callTranscriptTurnRepo.attachRecording(tenantId, callSid, voiceRecordingId);
      persistedForCall = await callTranscriptTurnRepo.listByCallSid(tenantId, callSid);
    } catch (err) {
      logger.error('recording-transcript-hook: attach/load of persisted turns failed', {
        callSid,
        voiceRecordingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const persisted = await redactSplitCardNumbers(
      { callTranscriptTurnRepo, logger },
      { tenantId, callSid, voiceRecordingId },
      persistedForCall
        .filter((t) => t.voiceRecordingId === voiceRecordingId)
        .map((t) => (unwritten.has(t.id) ? { ...t, text: unwritten.get(t.id)! } : t)),
    );

    // Source of the ingestion payload. The persisted rows carry the
    // renumbered indices the worker upserts onto, so they win when they are
    // at least as complete as the in-memory transcript. But a mid-call
    // persist is fire-and-forget: one that failed or is still in flight
    // leaves a gap the rows cannot show, while the session still holds every
    // line. When the session is live and longer, it is the more complete
    // record — ingest it in full rather than a transcript missing a turn
    // (PR #975 review finding 2). The attach above ran either way, so the
    // worker's (voice_recording_id, turn_index) upserts land on the rows
    // that do exist and fill in the rest.
    //
    // Two voice_recordings rows per call are legal (the voicemail leg is a
    // second recording for the same CallSid). Rows another recording already
    // claimed belong to THAT recording's ingestion, which has run: they are
    // never re-ingested under this one, whether or not a session is still in
    // memory — the session-wins rule only applies when every persisted row
    // for the call is this recording's, otherwise a live session would
    // duplicate the first recording's turns under the second id (found at
    // runtime verification of PR #975).
    const heldByOtherRecordings = persistedForCall.length > persisted.length;
    let turns: TranscriptIngestionTurn[];
    if (persisted.length === 0 && heldByOtherRecordings) {
      logger.info('recording-transcript-hook: turns already attached to another recording of this call', {
        callSid,
        voiceRecordingId,
      });
      return;
    } else if (session && !heldByOtherRecordings && session.transcript.length > persisted.length) {
      turns = session.transcript.map((line, index) => ({ index, ...parseTranscriptLine(line) }));
    } else if (persisted.length > 0) {
      turns = persisted.map((t) => ({ index: t.turnIndex, speaker: t.speaker, text: t.text }));
    } else if (session) {
      turns = session.transcript.map((line, index) => ({ index, ...parseTranscriptLine(line) }));
    } else {
      try {
        await auditRepo.create(
          createAuditEvent({
            tenantId,
            actorId: 'recording_webhook',
            actorRole: 'system',
            eventType: TRANSCRIPT_UNRECOVERABLE_EVENT,
            entityType: 'voice_recording',
            entityId: voiceRecordingId,
            metadata: { callSid, durationSeconds: event.durationSeconds },
          }),
        );
      } catch (err) {
        logger.error('recording-transcript-hook: failed to audit unrecoverable transcript', {
          callSid,
          voiceRecordingId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn('recording-transcript-hook: no session and no persisted turns — transcript unrecoverable', {
        callSid,
        voiceRecordingId,
      });
      return;
    }

    // PRIV-3 — the transcript holds the marker, the audio still holds the digits.
    if (turns.some((t) => t.speaker === 'caller' && containsCardNumber(t.text))) {
      await flagCardNumberRecording(
        { voiceRepo, auditRepo, logger },
        { tenantId, voiceRecordingId, actorId: 'recording_webhook', source: 'call_transcript' },
      );
    }

    if (!queue) return; // no ingestion worker registered (no embedding provider)

    const payload: TranscriptIngestionPayload = {
      tenantId,
      voiceRecordingId,
      turns,
      ...(session?.machine.currentContext.currentIntent
        ? { intent: session.machine.currentContext.currentIntent }
        : {}),
      // B2: thread the typed CallOutcome into the worker payload so
      // voice_recordings.outcome gets stamped alongside voice_sessions.outcome.
      // Optional — the worker no-ops when undefined.
      ...(session?.terminalOutcome ? { outcome: session.terminalOutcome } : {}),
      ...(session ? { durationMs: Date.now() - session.createdAt.getTime() } : {}),
    };
    try {
      await queue.send('transcript_ingestion', payload, `transcript:${voiceRecordingId}:v1`);
    } catch (err) {
      logger.error('recording-transcript-hook: failed to enqueue transcript_ingestion', {
        voiceRecordingId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
