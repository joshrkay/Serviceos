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
 *      land are written (`writeUnwrittenCardRedactions`), and so are the
 *      rewrites still queued for the call (`pendingCardNumberRewrites`: after
 *      a restart, or on another replica, no session knows of them, and the
 *      completing row is the marker, so no re-read of the rows can find the
 *      card); then the rows are read again in the live window
 *      (`redactSplitCardNumbers`). A rewrite that does not land is still what
 *      is ingested: by row id, or, queued before the rows' ids were known, by
 *      their mid-call key looked up before the claim renumbers them
 *      (`tieMidCallKeys`; `applyByFit` when that lookup fails too).
 *
 * Failure-soft throughout — the recording is already on disk by the time
 * this runs, and the router 200s Twilio regardless.
 */
import type { VoiceSession, VoiceSessionStore } from '../ai/agents/customer-calling/voice-session-store';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import type { Queue } from '../queues/queue';
import {
  CARD_NUMBER_PLACEHOLDER,
  containsCardNumber,
  HOLDS_DIGITS,
  redactCardNumbersInCallTurns,
} from '../ai/privacy/pan-redact';
import { flagCardNumberRecording } from '../voice/card-number-recording';
import { errorClass, type CardNumberRewriteRetryJob } from '../voice/card-number-rewrite-retry';
import type { VoiceRepository } from '../voice/voice-service';
import {
  cardMarkerCount,
  parseTranscriptLine,
  type CallTranscriptTurn,
  type CallTranscriptTurnRepository,
  type CallTurnSpeaker,
  type RedactCardNumberTurnsInput,
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
  /**
   * PRIV-3 — the card-number rewrites of this call's rows still on the
   * durable queue (`pendingCardNumberRewrites` in
   * voice/card-number-rewrite-retry.ts). Omitted ⇒ only a session in memory
   * can say what a split card's fragments must become.
   */
  pendingCardNumberRewrites?: (tenantId: string, callSid: string) => Promise<CardNumberRewriteRetryJob[]>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export const TRANSCRIPT_UNRECOVERABLE_EVENT = 'voice.transcript_unrecoverable';

const CARD_REWRITE_FAILED = 'recording-transcript-hook: card-number rewrite of stored turns failed';

type HookIds = { tenantId: string; callSid: string; voiceRecordingId: string };

/** Of two texts for one row, the one holding more card markers (the later rewrite). */
function mostRedacted(a: string | undefined, b: string): string {
  return a !== undefined && cardMarkerCount(a) >= cardMarkerCount(b) ? a : b;
}

/**
 * PRIV-3 — the redacted text of the rows the call's cross-turn card rewrites
 * name, for what is ingested whether or not writing them landed: by row id
 * (`byId`), and, for a rewrite queued before its rows' ids were known whose
 * write failed, by their mid-call key until the rows are looked up
 * (`byMidCallKey`, `tieMidCallKeys`).
 */
interface CardRedactionTexts {
  byId: Map<string, string>;
  byMidCallKey: Map<string, { sessionId: string; speaker: CallTurnSpeaker; text: string }>;
}

function midCallKey(sessionId: string, speaker: CallTurnSpeaker, turnIndex: number): string {
  return `${sessionId}\u0000${speaker}\u0000${turnIndex}`;
}

/**
 * PRIV-3 — write one cross-turn card rewrite of a session's rows in its
 * audited transaction, recording into `texts` the text of every row it names
 * by id, landed or not, and of every row it names only by its mid-call key
 * when it did not land, so the ingested text is the redacted one either way.
 * A failed write is logged (indexes and the error's class only, never text).
 * Returns whether it landed. Idempotent: a row that already reads so, or
 * reads more redacted, is left as it is.
 */
async function writeCardRedaction(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: HookIds,
  sessionId: string,
  turns: RedactCardNumberTurnsInput['turns'],
  texts: CardRedactionTexts,
): Promise<boolean> {
  for (const turn of turns) if (turn.id) texts.byId.set(turn.id, mostRedacted(texts.byId.get(turn.id), turn.text));
  try {
    await deps.callTranscriptTurnRepo.redactCardNumberTurns({
      tenantId: ids.tenantId,
      callSid: ids.callSid,
      sessionId,
      actorId: 'recording_webhook',
      turns,
    });
    return true;
  } catch (err) {
    for (const turn of turns) {
      if (turn.id) continue;
      const speaker = turn.speaker ?? 'caller';
      const key = midCallKey(sessionId, speaker, turn.turnIndex);
      texts.byMidCallKey.set(key, { sessionId, speaker, text: mostRedacted(texts.byMidCallKey.get(key)?.text, turn.text) });
    }
    deps.logger.error(CARD_REWRITE_FAILED, {
      callSid: ids.callSid,
      voiceRecordingId: ids.voiceRecordingId,
      sessionId,
      turnIndexes: turns.map((t) => t.turnIndex),
      error: errorClass(err),
    });
    return false;
  }
}

/**
 * PRIV-3 — the rows a rewrite that did not land named only by their mid-call
 * key, looked up by it before the recording claims them (`attachRecording`
 * renumbers them, and the key names no row after), so their redacted text is
 * recorded by id. A row the key finds no longer (its insert never landed)
 * holds nothing to carry. A lookup that fails is logged (by class), and the
 * keys are kept for `applyByFit`.
 */
async function tieMidCallKeys(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: HookIds,
  texts: CardRedactionTexts,
): Promise<void> {
  if (texts.byMidCallKey.size === 0) return;
  let rows: CallTranscriptTurn[];
  try {
    rows = await deps.callTranscriptTurnRepo.listByCallSid(ids.tenantId, ids.callSid);
  } catch (err) {
    deps.logger.error('recording-transcript-hook: rows of a card-number rewrite could not be looked up', {
      callSid: ids.callSid,
      voiceRecordingId: ids.voiceRecordingId,
      error: errorClass(err),
    });
    return;
  }
  for (const row of rows) {
    if (row.voiceRecordingId || !row.sessionId) continue;
    const named = texts.byMidCallKey.get(midCallKey(row.sessionId, row.speaker, row.turnIndex));
    if (named) texts.byId.set(row.id, mostRedacted(texts.byId.get(row.id), named.text));
  }
  texts.byMidCallKey.clear();
}

/** A stretch that begins, and one that ends, with a digit or a number word (`HOLDS_DIGITS`). */
const BEGINS_WITH_DIGITS = new RegExp(String.raw`^\s*(?:${HOLDS_DIGITS.source})`, 'iu');
const ENDS_WITH_DIGITS = new RegExp(String.raw`(?:${HOLDS_DIGITS.source})\s*$`, 'iu');

const literal = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A stretch that is a card marked already: the marker, or Deepgram's card tag in a row stored before the scrubber. */
const MARKED_CARD = new RegExp(String.raw`^\s*(?:${literal(CARD_NUMBER_PLACEHOLDER)}|\[CREDIT_CARD(?:_\d+)?\])\s*$`, 'u');

/**
 * True when `text` reads as `redacted` with each card marker standing for
 * what the caller said there: the same before, between and after the
 * markers, fewer markers of its own, and where each marker stands a stretch
 * that begins and ends with a digit or a number word, as the stretch the
 * scrubber replaced with it does ("four one one one, uh, one one one one"),
 * or a card the row has marked already ("the old one was [card number], the
 * new one is 4111 1111"). A row with none there is another turn, though it
 * holds a number word or a code ("the one upstairs", "sí, a las tres", "the
 * gate code is 4821, see you tomorrow"): a turn of nothing but the marker (a
 * split card's middle groups) fits every row on its text alone.
 */
function fitsRedaction(text: string, redacted: string): boolean {
  if (cardMarkerCount(text) >= cardMarkerCount(redacted)) return false;
  const fit = new RegExp(`^${redacted.split(CARD_NUMBER_PLACEHOLDER).map(literal).join('(.*?\\S.*?)')}$`, 's').exec(text);
  return (
    fit !== null &&
    fit.slice(1).every((said) => MARKED_CARD.test(said) || (BEGINS_WITH_DIGITS.test(said) && ENDS_WITH_DIGITS.test(said)))
  );
}

/**
 * PRIV-3 — the last resort for a rewrite that neither landed nor had its
 * rows looked up before the recording's claim renumbered them (both writes
 * failed): every row of its session and speaker that fits its text
 * (`fitsRedaction`) is ingested as that text. A turn of nothing but the card
 * fits any row of that speaker in the leg that begins and ends with a digit
 * or a number word, so an unrelated one that is nothing but a number (a bare
 * gate code or house number, "one, uh, two") is ingested as the marker too:
 * in this double failure the ingested transcript errs on the side of the
 * marker. A row with words of its own around its numbers ("the one
 * upstairs", "thanks, the gate code is 4821, see you tomorrow"), or with
 * none (the caller's name, the problem described), is left as it is.
 */
function applyByFit(rows: CallTranscriptTurn[], texts: CardRedactionTexts): CallTranscriptTurn[] {
  if (texts.byMidCallKey.size === 0) return rows;
  const named = [...texts.byMidCallKey.values()];
  return rows.map((row) => {
    let text = row.text;
    for (const n of named) {
      if (n.sessionId === row.sessionId && n.speaker === row.speaker && fitsRedaction(text, n.text)) text = n.text;
    }
    return text === row.text ? row : { ...row, text };
  });
}

/**
 * PRIV-3 — the session's cross-turn card rewrites of its stored rows that
 * did not land. The completing turn was stored already rewritten, so the
 * fragments left in the earlier rows ("my card is 4111 1111", "1111") no
 * longer read as a card: no re-read of the rows can find them, only the
 * session (or the queue, below) knows what they must say. Its in-flight
 * rewrites are awaited first (they land, or fail and join the list), then
 * each unwritten one is written; one that fails again is kept.
 */
async function writeUnwrittenCardRedactions(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: HookIds,
  session: VoiceSession,
  texts: CardRedactionTexts,
): Promise<void> {
  await session.cardRedactionWrites;
  for (const turns of session.unwrittenCardRedactions.splice(0)) {
    if (!(await writeCardRedaction(deps, ids, session.id, turns, texts))) session.unwrittenCardRedactions.push(turns);
  }
}

/**
 * PRIV-3 — the call's rewrites still on the durable queue. Every cross-turn
 * rewrite is queued before its live write (VoiceSessionStore), delayed for
 * the retry worker; after a restart, or with the callback on another replica,
 * no session knows of them and nothing else says what the fragments must
 * become. Each is written (oldest first) before the call is ingested; the
 * worker's own run of it later changes nothing. A lookup that fails is
 * logged (by class) and the rows are ingested as read.
 */
async function writeQueuedCardRedactions(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger' | 'pendingCardNumberRewrites'>,
  ids: HookIds,
  texts: CardRedactionTexts,
): Promise<void> {
  if (!deps.pendingCardNumberRewrites) return;
  let jobs: CardNumberRewriteRetryJob[];
  try {
    jobs = await deps.pendingCardNumberRewrites(ids.tenantId, ids.callSid);
  } catch (err) {
    deps.logger.error('recording-transcript-hook: queued card-number rewrites could not be read', {
      callSid: ids.callSid,
      voiceRecordingId: ids.voiceRecordingId,
      error: errorClass(err),
    });
    return;
  }
  for (const job of jobs) await writeCardRedaction(deps, ids, job.sessionId, job.turns, texts);
}

/**
 * PRIV-3 — a card number a caller split across turns whose every part is
 * still digits in this recording's stored rows (no live rewrite ever saw it:
 * rows from a process without the stitching). Each session leg's caller rows
 * are read again exactly as the live path reads them
 * (`redactCardNumbersInCallTurns`: the same window, by the time each row
 * was stored, with the agent's rows around it as context; an agent row
 * between the card's turns is rewritten only where it repeats a part of the
 * card, the confirm readback), and every row that held part of a card is
 * rewritten in one audited transaction per leg (`redactCardNumberTurns`).
 * Returns the rows as they now read; a failed write is logged (indexes only,
 * never text) and the rewritten text is still what is ingested.
 */
async function redactSplitCardNumbers(
  deps: Pick<RecordingTranscriptHookDeps, 'callTranscriptTurnRepo' | 'logger'>,
  ids: { tenantId: string; callSid: string; voiceRecordingId: string },
  rows: CallTranscriptTurn[],
): Promise<CallTranscriptTurn[]> {
  const legs = new Map<string, CallTranscriptTurn[]>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const leg = legs.get(row.sessionId);
    if (leg) leg.push(row);
    else legs.set(row.sessionId, [row]);
  }
  const rewritten = new Map<string, string>();
  for (const [sessionId, legRows] of legs) {
    const texts = redactCardNumbersInCallTurns(
      legRows.map((row) => ({ speaker: row.speaker, text: row.text, at: row.startedAt.getTime() })),
    );
    if (!texts) continue;
    const turns = legRows.flatMap((row, k) =>
      texts[k] === row.text
        ? []
        : [
            {
              id: row.id,
              turnIndex: row.turnIndex,
              ...(row.speaker === 'agent' ? { speaker: row.speaker } : {}),
              text: texts[k],
            },
          ],
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
        error: errorClass(err),
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
  const { store, callTranscriptTurnRepo, voiceRepo, auditRepo, queue, logger, pendingCardNumberRewrites } = deps;

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

    // PRIV-3 — the card rewrites of the call's rows that did not land (in
    // the session's memory) or are still queued, written before the rows are
    // attached and read: row id → the redacted text.
    const ids: HookIds = { tenantId, callSid, voiceRecordingId };
    const unwritten: CardRedactionTexts = { byId: new Map(), byMidCallKey: new Map() };
    if (session) await writeUnwrittenCardRedactions({ callTranscriptTurnRepo, logger }, ids, session, unwritten);
    await writeQueuedCardRedactions({ callTranscriptTurnRepo, logger, pendingCardNumberRewrites }, ids, unwritten);
    await tieMidCallKeys({ callTranscriptTurnRepo, logger }, ids, unwritten);

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
      ids,
      applyByFit(
        persistedForCall
          .filter((t) => t.voiceRecordingId === voiceRecordingId)
          .map((t) => (unwritten.byId.has(t.id) ? { ...t, text: mostRedacted(unwritten.byId.get(t.id), t.text) } : t)),
        unwritten,
      ),
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
