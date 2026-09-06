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
 *
 * Failure-soft throughout — the recording is already on disk by the time
 * this runs, and the router 200s Twilio regardless.
 */
import type { VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import type { Queue } from '../queues/queue';
import {
  parseTranscriptLine,
  type CallTranscriptTurnRepository,
} from '../voice/call-transcript-turn';
import type {
  TranscriptIngestionPayload,
  TranscriptIngestionTurn,
} from '../workers/transcript-ingestion-worker';
import type { RecordingPersistedEvent } from './recording-webhook';

export interface RecordingTranscriptHookDeps {
  store: Pick<VoiceSessionStore, 'findByCallSidIncludingEnded'>;
  callTranscriptTurnRepo: Pick<CallTranscriptTurnRepository, 'attachRecording' | 'listByCallSid'>;
  auditRepo: Pick<AuditRepository, 'create'>;
  /** Omit when no transcript-ingestion worker is registered (no embedding provider). */
  queue?: Pick<Queue, 'send'>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export const TRANSCRIPT_UNRECOVERABLE_EVENT = 'voice.transcript_unrecoverable';

export function createRecordingTranscriptHook(
  deps: RecordingTranscriptHookDeps,
): (event: RecordingPersistedEvent) => Promise<void> {
  const { store, callTranscriptTurnRepo, auditRepo, queue, logger } = deps;

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
    const persisted = persistedForCall.filter((t) => t.voiceRecordingId === voiceRecordingId);

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
