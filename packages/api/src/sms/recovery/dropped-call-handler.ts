/**
 * P8-015 — Dropped-call recovery orchestrator.
 *
 * Executes ONE due recovery row: the worker hands it a
 * `DroppedCallRecoveryRow` and this handler decides whether to send and, if
 * so, composes + sends + threads the SMS. The decision is re-evaluated HERE
 * (at T=60s), not just at schedule time (T=0), so the suppression rules from
 * the review prompt hold even when the world changed during the delay:
 *
 *   1. Booking completed since the drop  → suppress (`booking_completed`).
 *      Between scheduling and sending the caller may have phoned back and
 *      booked; we must not apologize for a call that ultimately succeeded.
 *   2. Per-caller rate limit (P0-036)    → suppress (`rate_limited`).
 *      scope=`sms_recovery`, limit=1, window=5min, keyed on the E.164. A
 *      caller who keeps dropping gets ONE recovery, not a flood.
 *   3. Otherwise → compose a brand-voice SMS (P4-015) with a PII-safe context
 *      cue, send it, and thread it (P0-037): link both `voice_session` and
 *      `sms_conversation` to the same conversation so the caller's reply
 *      continues the original intake thread.
 *
 * Composition / send / threading are injected so the worker stays a thin
 * polling loop and this orchestrator is unit-testable without a live DB,
 * Twilio, or the AI gateway.
 */
import type { Logger } from '../../logging/logger';
import type { AuditRepository } from '../../audit/audit';
import { createAuditEvent } from '../../audit/audit';
import { extractContextCue } from '../../voice/recovery/extract-context-cue';
import { composeStateAwareCue } from './state-aware-cue';
import type {
  DroppedCallRecoveryContext,
  DroppedCallRecoveryRepository,
  DroppedCallRecoveryRow,
} from './scheduler';

/** P0-036 rate-limit knobs for the recovery scope. */
export const RECOVERY_RATE_LIMIT_SCOPE = 'sms_recovery';
export const RECOVERY_RATE_LIMIT_MAX = 1;
export const RECOVERY_RATE_LIMIT_WINDOW_MS = 5 * 60_000;

/** Max characters for the recovery SMS body (one segment-ish). */
export const RECOVERY_SMS_MAX_CHARS = 320;

/** Actor stamped on recovery audit rows when no system actor is wired. */
const DEFAULT_SYSTEM_ACTOR = 'system:dropped-call-recovery';

export type RecoveryDisposition =
  | { action: 'sent'; smsMessageSid: string }
  | { action: 'suppressed'; reason: string };

/**
 * Per-caller throttle (P0-036), split into a non-consuming pre-send check and a
 * post-send record so a transient send failure cannot burn the caller's single
 * recovery token and strand the row (a re-drain would otherwise suppress it as
 * `rate_limited` and the recovery would never go out).
 *
 *   - `check`  → would a send be allowed right now? Records NOTHING. Wraps
 *                `PhoneRateLimiter.check(tenantId, scope, key, limit, windowMs)`.
 *   - `record` → register one send AFTER it actually went out. Wraps
 *                `PhoneRateLimiter.tryConsume(...)`.
 */
export interface RecoveryRateLimiter {
  check(tenantId: string, callerE164: string): Promise<boolean>;
  record(tenantId: string, callerE164: string): Promise<void>;
}

/**
 * Re-check at execution time: did this voice session ultimately resolve with a
 * successful booking / owner transfer (possibly via a call-back) since the
 * drop? Returns the suppression reason when it did, or null to proceed.
 *
 * The optional third argument carries the row's persisted FSM context
 * snapshot so a production checker can consult `proposalIds` (proposals
 * carry no session FK); two-argument implementations remain compatible.
 */
export type ResolvedSinceChecker = (
  tenantId: string,
  voiceSessionId: string,
  context?: DroppedCallRecoveryContext | null,
) => Promise<'booking_completed' | 'transferred' | null>;

/**
 * Optional compliance gate run AFTER resolvedSince and BEFORE the rate
 * limit: returns a suppression reason (e.g. 'opted_out' for a caller on the
 * tenant's DNC list) or null to proceed. Kept separate from resolvedSince —
 * consent is not booking state.
 */
export type RecoveryPreSendSuppress = (
  row: DroppedCallRecoveryRow,
) => Promise<string | null>;

/** Compose the brand-voice SMS body (P4-015). Returns the final text. */
export type RecoveryMessageComposer = (input: {
  tenantId: string;
  contextCue: string;
  maxChars: number;
}) => Promise<string>;

/** Send the SMS; returns the provider message sid. */
export type RecoverySmsSender = (input: {
  tenantId: string;
  to: string;
  body: string;
  idempotencyKey: string;
}) => Promise<string>;

/**
 * Thread the recovery: link both the originating voice_session and the new
 * sms_conversation to one conversation so the caller's reply lands in the same
 * intake thread (P0-037 LinkableEntityType). Implementations resolve/create
 * the conversation; a no-op is acceptable when threading is unavailable.
 */
export type RecoveryThreader = (input: {
  tenantId: string;
  voiceSessionId: string;
  smsMessageSid: string;
}) => Promise<void>;

export interface DroppedCallHandlerDeps {
  repo: DroppedCallRecoveryRepository;
  audit: AuditRepository;
  logger: Logger;
  rateLimit: RecoveryRateLimiter;
  resolvedSince: ResolvedSinceChecker;
  /** Compliance gate (DNC/consent) — suppresses with the returned reason. */
  preSendSuppress?: RecoveryPreSendSuppress;
  compose: RecoveryMessageComposer;
  sendSms: RecoverySmsSender;
  thread?: RecoveryThreader;
  /** FSM top-intent for the row, resolved by the worker. Optional. */
  topIntentFor?: (
    tenantId: string,
    voiceSessionId: string,
  ) => Promise<string | undefined>;
  systemActorId?: string;
  now?: () => Date;
}

/**
 * Handle one due recovery row. Stamps the row terminal (sent or suppressed)
 * via the repo so a re-drain is idempotent. Never throws on a business
 * suppression; only genuine infrastructure errors (compose/send) propagate so
 * the worker can retry the row on a later poll.
 */
export async function handleDroppedCallRecovery(
  row: DroppedCallRecoveryRow,
  deps: DroppedCallHandlerDeps,
): Promise<RecoveryDisposition> {
  const now = deps.now ?? (() => new Date());
  const actorId = deps.systemActorId ?? DEFAULT_SYSTEM_ACTOR;

  // 1. Suppression re-check — booking completed / transferred since the drop.
  const resolved = await deps.resolvedSince(row.tenantId, row.voiceSessionId, row.context);
  if (resolved) {
    await suppress(row, resolved, deps, actorId);
    return { action: 'suppressed', reason: resolved };
  }

  // 1b. Compliance gate — a caller who opted out (STOP) between the drop and
  //     the send must never receive the recovery SMS. Runs before the rate
  //     limit so a suppressed send can't interfere with the token check.
  if (deps.preSendSuppress) {
    const complianceReason = await deps.preSendSuppress(row);
    if (complianceReason) {
      await suppress(row, complianceReason, deps, actorId);
      return { action: 'suppressed', reason: complianceReason };
    }
  }

  // 2. Per-caller rate limit (P0-036) — CHECK only (non-consuming) so a
  //    transient compose/send failure below can't burn the caller's single
  //    token and strand the row. The token is recorded after the send succeeds.
  const allowed = await deps.rateLimit.check(row.tenantId, row.callerE164);
  if (!allowed) {
    await suppress(row, 'rate_limited', deps, actorId);
    return { action: 'suppressed', reason: 'rate_limited' };
  }

  // 3. Compose (brand voice + PII-safe context cue), send, thread, stamp.
  //    RV-115 — the persisted FSM snapshot wins (state-aware cue: proposal
  //    status vs "about your <intent>"); rows without context fall back to
  //    the legacy top-intent template lookup.
  let contextCue = composeStateAwareCue(row.context);
  if (!contextCue) {
    const topIntent = deps.topIntentFor
      ? await deps.topIntentFor(row.tenantId, row.voiceSessionId)
      : undefined;
    contextCue = extractContextCue(topIntent);
  }

  const body = await deps.compose({
    tenantId: row.tenantId,
    contextCue,
    maxChars: RECOVERY_SMS_MAX_CHARS,
  });

  const smsMessageSid = await deps.sendSms({
    tenantId: row.tenantId,
    to: row.callerE164,
    body,
    // Idempotent on the recovery row id so a retry never double-sends.
    idempotencyKey: `dropped_call_recovery:${row.id}`,
  });

  // Record the rate-limit consumption now that the SMS has actually gone out.
  // Best-effort: the message is already sent, so a record failure must not roll
  // it back (we'd re-send on retry); the only cost is a slightly looser limit.
  try {
    await deps.rateLimit.record(row.tenantId, row.callerE164);
  } catch (err) {
    deps.logger.warn('dropped-call recovery rate-limit record failed', {
      tenantId: row.tenantId,
      voiceSessionId: row.voiceSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (deps.thread) {
    try {
      await deps.thread({
        tenantId: row.tenantId,
        voiceSessionId: row.voiceSessionId,
        smsMessageSid,
      });
    } catch (err) {
      // Threading is best-effort: the SMS already went out, so a link failure
      // must not roll it back (we'd re-send on retry). Log + continue.
      deps.logger.warn('dropped-call recovery threading failed', {
        tenantId: row.tenantId,
        voiceSessionId: row.voiceSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await deps.repo.markSent(row.tenantId, row.id, smsMessageSid, now());
  await deps.audit.create(
    createAuditEvent({
      tenantId: row.tenantId,
      actorId,
      actorRole: 'system',
      eventType: 'dropped_call_recovery.sent',
      entityType: 'voice_session',
      entityId: row.voiceSessionId,
      metadata: {
        recoveryId: row.id,
        smsMessageSid,
        hadContextCue: contextCue.length > 0,
      },
    }),
  );

  deps.logger.info('dropped-call recovery SMS sent', {
    tenantId: row.tenantId,
    voiceSessionId: row.voiceSessionId,
    smsMessageSid,
    hadContextCue: contextCue.length > 0,
  });

  return { action: 'sent', smsMessageSid };
}

async function suppress(
  row: DroppedCallRecoveryRow,
  reason: string,
  deps: DroppedCallHandlerDeps,
  actorId: string,
): Promise<void> {
  await deps.repo.markSuppressed(row.tenantId, row.id, reason);
  await deps.audit.create(
    createAuditEvent({
      tenantId: row.tenantId,
      actorId,
      actorRole: 'system',
      eventType: 'dropped_call_recovery.suppressed',
      entityType: 'voice_session',
      entityId: row.voiceSessionId,
      metadata: { recoveryId: row.id, reason },
    }),
  );
  deps.logger.info('dropped-call recovery suppressed', {
    tenantId: row.tenantId,
    voiceSessionId: row.voiceSessionId,
    reason,
  });
}
