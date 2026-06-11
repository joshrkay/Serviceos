/**
 * P8-015 — Dropped-call SMS recovery event contract.
 *
 * When an inbound voice session ends without a resolved outcome (caller hung
 * up before booking/transfer, audio-quality failure, or a system error
 * mid-call) the calling agent schedules a brand-voice recovery SMS to the
 * caller ~60s later. This module is the single typed contract for that
 * deferred-send event:
 *
 *   - `DroppedCallEventSchema` validates the payload that the scheduler
 *     persists (and the worker later drains) so the durable
 *     `dropped_call_recoveries` row and the in-flight event never diverge.
 *   - `DROPPED_CALL_OUTCOMES` enumerates exactly the two terminal CallOutcome
 *     values that arm recovery. Successful bookings and owner transfers are
 *     deliberately excluded (recovery is suppressed for them).
 *   - `DROPPED_CALL_SUPPRESSED_REASONS` enumerates the reasons the worker may
 *     skip the send at execution time (re-checked at T=60s, not just T=0).
 *
 * Brand-voice composition (P4-015) and threading (P0-037 LinkableEntityType)
 * are wired by the API-side handler; this contract only freezes the event
 * shape so producer (scheduler) and consumer (worker) agree.
 */
import { z } from 'zod';

/**
 * The terminal CallOutcome values that arm a recovery SMS. Mirrors the
 * `CallOutcome` union in packages/api/src/voice/voice-service.ts — only
 * `dropped` (caller hung up before any resolution) and `failed` (system /
 * audio failure mid-call) trigger recovery. `completed`,
 * `escalated_to_human`, `callback_required`, and `no_intent` never do.
 */
export const DROPPED_CALL_OUTCOMES = ['dropped', 'failed'] as const;
export type DroppedCallOutcome = (typeof DROPPED_CALL_OUTCOMES)[number];

/**
 * Reasons the worker suppresses the send when it re-evaluates at execution
 * time. `booking_completed` covers the race where the caller phones back and
 * books between scheduling (T=0) and sending (T=60s); `rate_limited` covers
 * the P0-036 per-caller throttle; `already_sent` covers idempotent re-drains.
 */
export const DROPPED_CALL_SUPPRESSED_REASONS = [
  'booking_completed',
  'transferred',
  'rate_limited',
  'already_sent',
] as const;
export type DroppedCallSuppressedReason =
  (typeof DROPPED_CALL_SUPPRESSED_REASONS)[number];

/**
 * The payload the scheduler persists and the worker drains. `callerE164` is
 * the only PII field; the partial-transcript context cue is intentionally NOT
 * carried here — it is re-derived from a fixed template seeded by the FSM's
 * top intent at send time so no free-form transcript text can leak.
 */
export const DroppedCallEventSchema = z.object({
  /** Tenant the dropped call belongs to (RLS scope). */
  tenantId: z.string().uuid(),
  /** The voice_sessions row the recovery threads back to. */
  voiceSessionId: z.string().uuid(),
  /** Caller phone in E.164 (e.g. "+15551234567"). */
  callerE164: z.string().min(7),
  /** Which terminal outcome armed recovery. */
  outcome: z.enum(DROPPED_CALL_OUTCOMES),
  /**
   * The single intent slug the FSM captured before the drop, if any. Used by
   * the API handler to pick a fixed context-cue template (never free-form
   * transcript text). Absent → generic apology.
   */
  topIntent: z.string().min(1).optional(),
  /** Epoch millis the recovery becomes eligible to send (drop time + 60s). */
  scheduledForMs: z.number().int().nonnegative(),
});

export type DroppedCallEvent = z.infer<typeof DroppedCallEventSchema>;

/** Queue message type discriminant for the deferred recovery send. */
export const DROPPED_CALL_RECOVERY_JOB_TYPE = 'dropped_call_recovery_sms' as const;

/** Deferred-send delay: SMS goes out ~60s after the drop is detected. */
export const DROPPED_CALL_RECOVERY_DELAY_MS = 60_000;
