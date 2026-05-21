/**
 * P8-015 — Dropped-call detection (pure function).
 *
 * Decides whether a terminal voice session should arm a recovery SMS. The
 * trigger site (inapp-adapter.finalizeTerminalOutcome) calls this AFTER it has
 * derived `session.terminalOutcome`, so detection is a cheap, synchronous,
 * side-effect-free predicate over the already-computed CallOutcome.
 *
 * Recovery arms ONLY for the two "we lost the caller without resolving"
 * outcomes:
 *   - `dropped` — caller hung up before any resolution.
 *   - `failed`  — system / audio failure mid-call.
 *
 * It is deliberately suppressed for `completed` (a booking happened),
 * `escalated_to_human` (owner transfer), `callback_required`, and `no_intent`
 * — sending an apology SMS after a successful booking or a human transfer
 * would be spammy and confusing.
 */
import type { CallOutcome } from '../voice-service';

/** The two terminal outcomes that arm a recovery SMS. */
export const RECOVERY_OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>([
  'dropped',
  'failed',
]);

export interface DropDetectionInput {
  /** The typed terminal outcome derived by the adapter/processor. */
  outcome: CallOutcome | undefined;
  /** Caller phone in E.164 — required to send the recovery. */
  callerE164?: string;
  /**
   * Channel the session ran on. Recovery is for inbound *voice* only; SMS- and
   * webchat-initiated sessions are out of scope (non-goal in the story).
   */
  channel: string;
}

/**
 * Returns true when the terminal session should schedule a recovery SMS.
 * Pure: no I/O, no clock, no randomness — fully unit-testable.
 */
export function shouldRecoverDroppedCall(input: DropDetectionInput): boolean {
  if (!input.outcome) return false;
  if (!RECOVERY_OUTCOMES.has(input.outcome)) return false;
  if (!isVoiceChannel(input.channel)) return false;
  return isUsableE164(input.callerE164);
}

/** Inbound/outbound real-voice channels eligible for recovery. */
function isVoiceChannel(channel: string): boolean {
  return (
    channel === 'voice_inbound' ||
    channel === 'inapp_voice' ||
    channel === 'telephony'
  );
}

/**
 * Minimal E.164 sanity check — a leading `+` is optional (Twilio "From"
 * sometimes arrives without it) but we require at least 7 digits so we never
 * schedule a send against an obviously bogus / anonymous caller id.
 */
export function isUsableE164(value: string | undefined): value is string {
  if (!value) return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7;
}
