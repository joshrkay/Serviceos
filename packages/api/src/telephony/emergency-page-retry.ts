/**
 * RV-143 / UC-5a — DURABLE emergency page-retry ladder.
 *
 * Armed the moment an emergency escalation starts (the deterministic scan /
 * FSM fast-path initiates the dispatcher transfer). If the transfer is still
 * unanswered after each interval, the owner is paged by SMS — up to
 * MAX_EMERGENCY_PAGES times at EMERGENCY_PAGE_INTERVAL_MS (2-minute)
 * intervals. When the ladder exhausts unanswered, an URGENT `call_me_back`
 * task is created (reason 'emergency_unanswered', scheduledFor = now) so the
 * CSR sweep (call-me-back-worker) keeps surfacing it until a human acts.
 *
 * Previously an in-process Map + setTimeout ladder: a deploy/restart DROPPED
 * every pending page, and two replicas scanning the same call could each arm
 * their own ladder (double-page). Each ladder step is now a DELAYED job on
 * the shared Postgres queue (PgQueue):
 *
 *   - `armEmergencyPageLadder` enqueues attempt 1, visible after intervalMs;
 *   - the worker processes attempt N: re-checks resolution, enqueues attempt
 *     N+1 (delayed) BEFORE paging — so a crash mid-page can never drop the
 *     ladder tail — then pages, and on the final attempt lands the durable
 *     call_me_back fallback.
 *
 * Exactly-once per ladder step:
 *   - idempotency key `emergency_page:{tenant}:{session}:{attempt}` — a
 *     double-arm (re-dispatched scan, replica race) or a replayed
 *     continuation enqueue is an ON CONFLICT no-op;
 *   - PgQueue's FOR UPDATE SKIP LOCKED — concurrent replicas claim disjoint
 *     messages, so one attempt is processed by exactly one consumer.
 *   The residual window is a crash between the SMS send and the queue
 *   delete: the redelivered attempt re-pages once. At-least-once, biased
 *   toward paging — the correct failure mode for a life-safety ladder (the
 *   in-memory version carried the same bias).
 *
 * "Answered" detection is durable too: the worker's injected `isResolved`
 * (production: `createEmergencyPageResolvedCheck`) checks the live session
 * store when this replica still holds the session, then falls back to the
 * persisted `voice_sessions.ended_reason === 'transferred'` (stamped by the
 * /dial-result success branch), so a ladder armed on replica A resolves
 * correctly when replica B answers the transfer. Indeterminate sessions
 * (row missing, lookup failing) keep paging.
 */
import { createLogger } from '../logging/logger';
import type { Logger } from '../logging/logger';
import type { Queue, WorkerHandler } from '../queues/queue';
import type { CallMeBackRepository } from '../voice/call-me-back/call-me-back';
import type { VoiceSessionRepository } from '../voice/voice-session';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const logger = createLogger({
  service: 'telephony.emergency-page-retry',
  environment: process.env.NODE_ENV || 'development',
});

export const EMERGENCY_PAGE_INTERVAL_MS = 2 * 60_000;
export const MAX_EMERGENCY_PAGES = 3;

/** Queue message type consumed by the unified poll loop (app.ts). */
export const EMERGENCY_PAGE_JOB_TYPE = 'telephony.emergency_page';

export interface EmergencyPageLadderInput {
  tenantId: string;
  sessionId: string;
  /** Twilio CallSid, when known (threaded onto the callback task). */
  callSid?: string;
  /** Caller's E.164, when known. Included in the page + callback task. */
  callerPhone?: string;
  /** NON-PII-trimmed emergency description (the triggering utterance). */
  emergencyDescription: string;
  businessName: string;
}

/** One ladder step as persisted on the queue. */
export interface EmergencyPageJobPayload extends EmergencyPageLadderInput {
  /** 1-based ladder step this job pages for. */
  attempt: number;
  maxPages: number;
  intervalMs: number;
}

export interface EmergencyPageLadderDeps {
  /** The shared durable queue (PgQueue in production). */
  queue: Queue;
  intervalMs?: number;
  maxPages?: number;
}

/** Idempotency key per escalation attempt (tenant + session + attempt). */
export function emergencyPageIdempotencyKey(
  tenantId: string,
  sessionId: string,
  attempt: number,
): string {
  return `emergency_page:${tenantId}:${sessionId}:${attempt}`;
}

export function composeEmergencyRetryPage(
  input: EmergencyPageLadderInput,
  attempt: number,
  maxPages: number,
): string {
  const caller = input.callerPhone ? ` Caller: ${input.callerPhone}.` : '';
  const body =
    `${input.businessName} EMERGENCY page ${attempt}/${maxPages} — transfer unanswered: ` +
    `${input.emergencyDescription}.${caller} Call back NOW.`;
  return body.length > 320 ? `${body.slice(0, 317)}…` : body;
}

/**
 * Arm the ladder: enqueue attempt 1 as a delayed queue job. Idempotent per
 * (tenantId, sessionId) — a re-dispatched scan or a second replica arming
 * the same escalation dedups on the attempt-1 idempotency key. Durable: the
 * job lives in Postgres, so a restart between arm and first page loses
 * nothing, and any replica's poll loop may fire it.
 */
export async function armEmergencyPageLadder(
  input: EmergencyPageLadderInput,
  deps: EmergencyPageLadderDeps,
): Promise<void> {
  const intervalMs = deps.intervalMs ?? EMERGENCY_PAGE_INTERVAL_MS;
  const maxPages = deps.maxPages ?? MAX_EMERGENCY_PAGES;
  const payload: EmergencyPageJobPayload = {
    ...input,
    attempt: 1,
    maxPages,
    intervalMs,
  };
  await deps.queue.send(
    EMERGENCY_PAGE_JOB_TYPE,
    payload,
    emergencyPageIdempotencyKey(input.tenantId, input.sessionId, 1),
    { delaySeconds: intervalMs / 1000 },
  );
}

export interface EmergencyPageWorkerDeps {
  /** Same queue the producer armed on — used to enqueue the next step. */
  queue: Queue;
  /** Outbound SMS (the same delivery provider the dispatch infra uses). */
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  /** Resolves the page target (owner cell, falling back per tenant). */
  resolvePagePhone: (tenantId: string) => Promise<string | null | undefined>;
  /**
   * True once the emergency transfer was ANSWERED (or the emergency is
   * otherwise resolved). Checked before every page; a resolved ladder
   * cancels silently (the next step is only enqueued by this worker, so
   * "don't continue" IS the cancellation).
   */
  isResolved: (tenantId: string, sessionId: string) => Promise<boolean>;
  /** Exhaustion fallback — the durable CSR queue. Optional. */
  callMeBackRepo?: CallMeBackRepository;
  auditRepo?: AuditRepository;
}

/**
 * Production `isResolved` wiring: prefer the live in-process session (fast
 * path when this replica still holds it), then the persisted
 * voice_sessions row — the cross-replica / post-restart source of truth.
 * Any failure is indeterminate → unresolved → keep paging.
 */
export function createEmergencyPageResolvedCheck(deps: {
  store?: {
    peek(sessionId: string): { terminalReason?: string } | undefined;
  };
  voiceSessionRepo?: Pick<VoiceSessionRepository, 'findById'>;
}): (tenantId: string, sessionId: string) => Promise<boolean> {
  return async (tenantId, sessionId) => {
    try {
      if (deps.store?.peek(sessionId)?.terminalReason === 'transferred') {
        return true;
      }
      if (deps.voiceSessionRepo) {
        const row = await deps.voiceSessionRepo.findById(tenantId, sessionId);
        return row?.endedReason === 'transferred';
      }
    } catch {
      /* indeterminate — bias toward paging on an emergency */
    }
    return false;
  };
}

function isEmergencyPageJobPayload(
  value: unknown,
): value is EmergencyPageJobPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<EmergencyPageJobPayload>;
  return (
    typeof v.tenantId === 'string' &&
    typeof v.sessionId === 'string' &&
    typeof v.emergencyDescription === 'string' &&
    typeof v.businessName === 'string' &&
    typeof v.attempt === 'number' &&
    Number.isFinite(v.attempt) &&
    typeof v.maxPages === 'number' &&
    Number.isFinite(v.maxPages) &&
    typeof v.intervalMs === 'number' &&
    Number.isFinite(v.intervalMs)
  );
}

/**
 * The queue consumer for one ladder step. Registered in app.ts's unified
 * worker registry; any replica's poll loop may claim a step.
 *
 * Ordering inside a step is deliberate:
 *   1. resolved? → done (silently cancels the rest of the ladder);
 *   2. enqueue attempt N+1 (delayed) — throws propagate so the queue's
 *      visibility retry re-runs the step rather than dropping the tail;
 *   3. page — best-effort: one failed page never stops the ladder;
 *   4. final attempt → durable URGENT call_me_back fallback (best-effort,
 *      matching the legacy ladder's swallow-and-log semantics).
 */
export function createEmergencyPageWorker(
  deps: EmergencyPageWorkerDeps,
): WorkerHandler<EmergencyPageJobPayload> {
  return {
    type: EMERGENCY_PAGE_JOB_TYPE,
    async handle(message, log: Logger): Promise<void> {
      const payload: unknown = message.payload;
      if (!isEmergencyPageJobPayload(payload)) {
        // Malformed jobs must not retry forever — log loudly and drop.
        log.error('emergency page job: malformed payload — dropping', {
          idempotencyKey: message.idempotencyKey,
        });
        return;
      }

      let resolved = false;
      try {
        resolved = await deps.isResolved(payload.tenantId, payload.sessionId);
      } catch {
        resolved = false; // bias toward paging
      }
      if (resolved) {
        log.info('emergency page ladder resolved — cancelling remaining pages', {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          attempt: payload.attempt,
        });
        return;
      }

      // Durable continuation FIRST: if this enqueue fails, the thrown error
      // fails the whole step and the queue redelivers it (no page has been
      // sent yet, so no duplicate). The per-attempt idempotency key makes a
      // replayed enqueue a no-op.
      if (payload.attempt < payload.maxPages) {
        await deps.queue.send(
          EMERGENCY_PAGE_JOB_TYPE,
          { ...payload, attempt: payload.attempt + 1 },
          emergencyPageIdempotencyKey(
            payload.tenantId,
            payload.sessionId,
            payload.attempt + 1,
          ),
          { delaySeconds: payload.intervalMs / 1000 },
        );
      }

      try {
        const to = await deps.resolvePagePhone(payload.tenantId);
        if (to) {
          await deps.sendSms({
            to,
            body: composeEmergencyRetryPage(
              payload,
              payload.attempt,
              payload.maxPages,
            ),
          });
          if (deps.auditRepo) {
            await deps.auditRepo
              .create(
                createAuditEvent({
                  tenantId: payload.tenantId,
                  actorId: 'emergency-page-retry',
                  actorRole: 'system',
                  eventType: 'emergency_page.sent',
                  entityType: 'voice_session',
                  entityId: payload.sessionId,
                  correlationId: payload.sessionId,
                  metadata: {
                    attempt: payload.attempt,
                    maxPages: payload.maxPages,
                  },
                }),
              )
              .catch(() => undefined);
          }
        } else {
          logger.warn('emergency page-retry: no page phone resolvable', {
            tenantId: payload.tenantId,
            sessionId: payload.sessionId,
            attempt: payload.attempt,
          });
        }
      } catch (err) {
        // One failed page never stops the ladder — the next attempt is
        // already enqueued above.
        logger.warn('emergency page-retry: page failed', {
          tenantId: payload.tenantId,
          sessionId: payload.sessionId,
          attempt: payload.attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (
        payload.attempt >= payload.maxPages &&
        deps.callMeBackRepo &&
        payload.callerPhone
      ) {
        // Ladder exhausted unanswered → durable URGENT callback task.
        try {
          await deps.callMeBackRepo.create({
            tenantId: payload.tenantId,
            sessionId: payload.sessionId,
            ...(payload.callSid ? { callSid: payload.callSid } : {}),
            callerPhone: payload.callerPhone,
            callbackMessage: `EMERGENCY (unanswered pages): ${payload.emergencyDescription}`,
            intentSummary: 'emergency_dispatch',
            reason: 'emergency_unanswered',
            scheduledFor: new Date(),
          });
        } catch (err) {
          logger.error('emergency page-retry: call_me_back fallback failed', {
            tenantId: payload.tenantId,
            sessionId: payload.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  };
}
