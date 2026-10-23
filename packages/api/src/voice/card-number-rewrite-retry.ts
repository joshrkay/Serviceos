/**
 * PRIV-3 (durability) — the durable retry of a cross-turn card-number
 * rewrite of the stored call rows (P0-009 async worker pattern).
 *
 * `VoiceSessionStore.appendTranscript` rewrites the rows that held part of a
 * card number the caller split across turns in one fire-and-forget
 * transaction. When that write fails, the completing turn's row is already
 * stored as the marker, so the fragments left in the earlier rows no longer
 * read as a card: no later re-read of the rows can find them again, and only
 * the rewrite itself says what they must become. The session keeps it in
 * memory for the recording hook, but a restart or deploy before the
 * recording callback, or a call with no recording, would leave the fragments
 * in call_transcript_turns for good. So the store also enqueues it here: the
 * job carries the rows (by id where known) and their already-redacted text,
 * never a digit of the card, and this worker writes them through the
 * repository's one audited transaction. The queue retries a failure with
 * backoff, bounded by its max attempts, then dead-letters it; the last
 * attempt's failure is logged, counted (`voice_card_number_rewrite_failed_total`,
 * stage `retry_exhausted`) and audited, with ids and turn indexes only.
 */
import { createHash } from 'crypto';
import { createAuditEvent, type AuditRepository } from '../audit/audit';
import type { Logger } from '../logging/logger';
import { cardNumberRewriteFailedTotal } from '../monitoring/metrics';
import type { Queue, QueueMessage, WorkerHandler } from '../queues/queue';
import type { CallTranscriptTurnRepository, RedactCardNumberTurnsInput } from './call-transcript-turn';

export const CARD_NUMBER_REWRITE_RETRY_JOB = 'voice.card_number_rewrite_retry';

/** Audited when the worker's last attempt fails: the call's rows still hold part of a card. */
export const CARD_NUMBER_REWRITE_FAILED_EVENT = 'voice.transcript_card_number_redaction_failed';

/** Who the retried rewrite's audit row names. */
const RETRY_ACTOR = 'card-number-rewrite-retry';

/** The rewrite to retry: the repository input, less who wrote it. */
export type CardNumberRewriteRetryJob = Omit<RedactCardNumberTurnsInput, 'actorId'>;

/**
 * An error by class only (its name, and a short enum-like code such as a
 * Postgres SQLSTATE): a database error's message can quote the row it failed
 * on, and the row holds part of a card.
 */
export function errorClass(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const code = (err as { code?: unknown }).code;
  const suffix = (typeof code === 'string' || typeof code === 'number') && /^[\w.-]{1,40}$/.test(String(code)) ? `:${code}` : '';
  return `${err.name.slice(0, 60)}${suffix}`;
}

/**
 * How long the queued rewrite waits before the worker may run it: the live
 * write it backs up normally lands within this, leaving it nothing to do. The
 * recording hook reads it at once whatever its delay.
 */
const RETRY_DELAY_SECONDS = 60;

/**
 * Enqueue `job` for the retry worker (and the recording hook). Keyed on the
 * session and a hash of the rewrite (row ids, indexes and redacted text), so a
 * redelivered enqueue is one job while a later, different rewrite of the same
 * rows is its own.
 */
export function enqueueCardNumberRewriteRetry(queue: Pick<Queue, 'send'>, job: CardNumberRewriteRetryJob): Promise<string> {
  const fingerprint = createHash('sha256').update(JSON.stringify(job.turns)).digest('hex').slice(0, 16);
  return queue.send(
    CARD_NUMBER_REWRITE_RETRY_JOB,
    job,
    `card-number-rewrite:${job.tenantId}:${job.sessionId}:${fingerprint}`,
    { delaySeconds: RETRY_DELAY_SECONDS },
  );
}

/** A queue the rewrites still queued for a call can be read from (PgQueue, InMemoryQueue). */
export interface PendingJobQueue {
  findPending<T>(type: string, match: Record<string, string>): Promise<QueueMessage<T>[]>;
}

/**
 * The card-number rewrites still queued for a call (delayed, or not yet run
 * by the worker), oldest first: what the recording hook writes before the
 * call is ingested when no session in memory knows of them (a restart since,
 * or the callback landing on another replica). A malformed payload is
 * dropped, as the worker drops it.
 */
export function pendingCardNumberRewrites(
  queue: PendingJobQueue,
): (tenantId: string, callSid: string) => Promise<CardNumberRewriteRetryJob[]> {
  return async (tenantId, callSid) =>
    (await queue.findPending<unknown>(CARD_NUMBER_REWRITE_RETRY_JOB, { tenantId, callSid }))
      .map((m) => m.payload)
      .filter(isJob);
}

function isJob(p: unknown): p is CardNumberRewriteRetryJob {
  const j = p as Partial<CardNumberRewriteRetryJob> | null;
  return (
    !!j &&
    typeof j.tenantId === 'string' &&
    typeof j.callSid === 'string' &&
    typeof j.sessionId === 'string' &&
    Array.isArray(j.turns) &&
    j.turns.length > 0 &&
    j.turns.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        Number.isInteger(t.turnIndex) &&
        typeof t.text === 'string' &&
        (t.id === undefined || typeof t.id === 'string') &&
        (t.speaker === undefined || t.speaker === 'caller' || t.speaker === 'agent'),
    )
  );
}

/** What may be logged of a job: its ids and turn indexes, never the rows' text. */
function jobIds(job: CardNumberRewriteRetryJob): Record<string, unknown> {
  return { tenantId: job.tenantId, callSid: job.callSid, sessionId: job.sessionId, turnIndexes: job.turns.map((t) => t.turnIndex) };
}

export interface CardNumberRewriteRetryWorkerDeps {
  callTranscriptTurnRepo: Pick<CallTranscriptTurnRepository, 'redactCardNumberTurns'>;
  auditRepo?: Pick<AuditRepository, 'create'>;
}

export function createCardNumberRewriteRetryWorker(
  deps: CardNumberRewriteRetryWorkerDeps,
): WorkerHandler<CardNumberRewriteRetryJob> {
  return {
    type: CARD_NUMBER_REWRITE_RETRY_JOB,
    // The queue logs this on every attempt: never the rows' text.
    describePayload: (payload) => (isJob(payload) ? jobIds(payload) : { malformed: true }),
    async handle(message, log: Logger): Promise<void> {
      const job: unknown = message.payload;
      if (!isJob(job)) {
        log.error('card-number rewrite retry: malformed job, dropping it', { messageId: message.id });
        return;
      }
      const ids = jobIds(job);
      try {
        // Rows that already read as the job says (the live write landed after
        // all, or the recording hook wrote it) are left alone and not audited.
        const rewritten = await deps.callTranscriptTurnRepo.redactCardNumberTurns({ ...job, actorId: RETRY_ACTOR });
        log.info('card-number rewrite of stored turns retried', { ...ids, rewritten });
      } catch (err) {
        if (message.attempts >= message.maxAttempts) {
          cardNumberRewriteFailedTotal.inc({ stage: 'retry_exhausted' });
          log.error('card-number rewrite of stored turns failed for good: the rows still hold part of a card', {
            ...ids,
            attempts: message.attempts,
            error: errorClass(err),
          });
          await deps.auditRepo
            ?.create(
              createAuditEvent({
                tenantId: job.tenantId,
                actorId: RETRY_ACTOR,
                actorRole: 'system',
                eventType: CARD_NUMBER_REWRITE_FAILED_EVENT,
                entityType: 'voice_session',
                entityId: job.sessionId,
                metadata: { callSid: job.callSid, turnIndexes: ids.turnIndexes, attempts: message.attempts },
              }),
            )
            .catch((auditErr: unknown) =>
              log.warn('card-number rewrite retry: failure audit not written', { ...ids, error: errorClass(auditErr) }),
            );
        }
        // The queue logs and records this error's message: by class only (the
        // cause stays attached for a debugger, never logged by the queue).
        throw new Error(`card-number rewrite of stored turns failed (${errorClass(err)})`, { cause: err });
      }
    },
  };
}
