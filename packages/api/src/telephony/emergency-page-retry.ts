/**
 * RV-143 — emergency page-retry ladder.
 *
 * Armed the moment an emergency escalation starts (the deterministic scan /
 * FSM fast-path initiates the dispatcher transfer). If the transfer is still
 * unanswered after each interval, the owner is paged by SMS — up to
 * MAX_EMERGENCY_PAGES times at EMERGENCY_PAGE_INTERVAL_MS (2-minute)
 * intervals. When the ladder exhausts unanswered, an URGENT `call_me_back`
 * task is created (reason 'emergency_unanswered', scheduledFor = now) so the
 * CSR sweep (call-me-back-worker) keeps surfacing it until a human acts.
 *
 * "Answered" detection is injected as `isResolved()` — production wires it
 * to the voice session's terminal state (the /dial-result success branch
 * stamps `terminalReason === 'transferred'`). The ladder is biased toward
 * paging: an indeterminate session (store already reaped) keeps paging.
 *
 * Like the B5 dropped-call MVP, the timers are in-process (not durable
 * across restarts) — acceptable for a 6-minute life-safety ladder where the
 * exhaustion fallback also lands in the durable call_me_back queue. Timers
 * are unref'd so they never hold the process open.
 */
import { createLogger } from '../logging/logger';
import type { CallMeBackRepository } from '../voice/call-me-back/call-me-back';
import { AuditRepository, createAuditEvent } from '../audit/audit';

const logger = createLogger({
  service: 'telephony.emergency-page-retry',
  environment: process.env.NODE_ENV || 'development',
});

export const EMERGENCY_PAGE_INTERVAL_MS = 2 * 60_000;
export const MAX_EMERGENCY_PAGES = 3;

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

export interface EmergencyPageLadderDeps {
  /** Outbound SMS (the same delivery provider the dispatch infra uses). */
  sendSms: (args: { to: string; body: string }) => Promise<unknown>;
  /** Resolves the page target (owner cell, falling back per caller). */
  resolvePagePhone: () => Promise<string | null | undefined>;
  /**
   * True once the emergency transfer was ANSWERED (or the emergency is
   * otherwise resolved). Checked before every page; a resolved ladder
   * cancels silently.
   */
  isResolved: () => boolean | Promise<boolean>;
  /** Exhaustion fallback — the durable CSR queue. Optional. */
  callMeBackRepo?: CallMeBackRepository;
  auditRepo?: AuditRepository;
  intervalMs?: number;
  maxPages?: number;
}

export interface EmergencyPageLadderHandle {
  cancel(): void;
}

/** Per-(tenant, session) dedup so a re-dispatched scan can't double-arm. */
const armed = new Map<string, EmergencyPageLadderHandle>();

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
 * Arm the ladder. Returns a handle whose `cancel()` stops all pending pages
 * (also called automatically once `isResolved()` reports true or the ladder
 * exhausts). Idempotent per (tenantId, sessionId).
 */
export function armEmergencyPageLadder(
  input: EmergencyPageLadderInput,
  deps: EmergencyPageLadderDeps,
): EmergencyPageLadderHandle {
  const key = `${input.tenantId}:${input.sessionId}`;
  const existing = armed.get(key);
  if (existing) return existing;

  const intervalMs = deps.intervalMs ?? EMERGENCY_PAGE_INTERVAL_MS;
  const maxPages = deps.maxPages ?? MAX_EMERGENCY_PAGES;
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const handle: EmergencyPageLadderHandle = {
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      armed.delete(key);
    },
  };
  armed.set(key, handle);

  const runAttempt = (attempt: number): void => {
    timer = setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        try {
          if (await deps.isResolved()) {
            handle.cancel();
            return;
          }
          const to = await deps.resolvePagePhone();
          if (to) {
            await deps.sendSms({
              to,
              body: composeEmergencyRetryPage(input, attempt, maxPages),
            });
            if (deps.auditRepo) {
              await deps.auditRepo
                .create(
                  createAuditEvent({
                    tenantId: input.tenantId,
                    actorId: 'emergency-page-retry',
                    actorRole: 'system',
                    eventType: 'emergency_page.sent',
                    entityType: 'voice_session',
                    entityId: input.sessionId,
                    correlationId: input.sessionId,
                    metadata: { attempt, maxPages },
                  }),
                )
                .catch(() => undefined);
            }
          } else {
            logger.warn('emergency page-retry: no page phone resolvable', {
              tenantId: input.tenantId,
              sessionId: input.sessionId,
              attempt,
            });
          }
        } catch (err) {
          // One failed page never stops the ladder — the next attempt still fires.
          logger.warn('emergency page-retry: page failed', {
            tenantId: input.tenantId,
            sessionId: input.sessionId,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (cancelled) return;
        if (attempt < maxPages) {
          runAttempt(attempt + 1);
        } else {
          // Ladder exhausted unanswered → durable URGENT callback task.
          if (deps.callMeBackRepo && input.callerPhone) {
            try {
              await deps.callMeBackRepo.create({
                tenantId: input.tenantId,
                sessionId: input.sessionId,
                ...(input.callSid ? { callSid: input.callSid } : {}),
                callerPhone: input.callerPhone,
                callbackMessage: `EMERGENCY (unanswered pages): ${input.emergencyDescription}`,
                intentSummary: 'emergency_dispatch',
                reason: 'emergency_unanswered',
                scheduledFor: new Date(),
              });
            } catch (err) {
              logger.error('emergency page-retry: call_me_back fallback failed', {
                tenantId: input.tenantId,
                sessionId: input.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          handle.cancel();
        }
      })();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  runAttempt(1);
  return handle;
}

/** Resolve an armed ladder early (transfer answered). Safe when not armed. */
export function resolveEmergencyPageLadder(tenantId: string, sessionId: string): void {
  armed.get(`${tenantId}:${sessionId}`)?.cancel();
}

/** Test-only. */
export function __clearEmergencyPageLaddersForTests(): void {
  for (const handle of [...armed.values()]) handle.cancel();
  armed.clear();
}
