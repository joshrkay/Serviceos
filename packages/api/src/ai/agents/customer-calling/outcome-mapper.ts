import type { CallOutcome } from '../../../voice/voice-service';
import type { CallingAgentContext, CallingAgentState } from './types';
import type { VoiceSession } from './voice-session-store';

export interface DeriveOutcomeInput {
  finalState: CallingAgentState;
  endedReason: string;
  context: CallingAgentContext;
  transcript: ReadonlyArray<string>;
  proposalIds: ReadonlyArray<string>;
}

function callerSpoke(transcript: ReadonlyArray<string>): boolean {
  return transcript.some((line) => line.toLowerCase().startsWith('caller:'));
}

export function deriveCallOutcome(input: DeriveOutcomeInput): CallOutcome {
  const { finalState, endedReason, context, transcript, proposalIds } = input;
  const spoke = callerSpoke(transcript);
  const intentSet = context.currentIntent !== undefined;
  const hasProposal = proposalIds.length > 0;

  if (endedReason.startsWith('abuse_detected:')) {
    return 'escalated_to_human';
  }

  // ANS-001 (NIT) — an E1 life-safety close is a real resolution (the caller
  // was directed to 911/the utility and the tenant was alerted for
  // follow-up), not an infra failure. Without this, 'life_safety_e1' fell
  // through every branch below to the generic 'failed' bucket, burying every
  // life-safety call in analytics as an infra regression. Mirrors the
  // abuse_detected special-case above; CallOutcome has no dedicated
  // life-safety value, and 'escalated_to_human' already reads correctly in
  // the interactions UI (OutcomeBadge) and is excluded from the
  // dropped-call-recovery outcome set (RECOVERY_OUTCOMES), which an E1 close
  // must never trigger.
  if (endedReason === 'life_safety_e1') {
    return 'escalated_to_human';
  }

  // Transport-layer failures emitted by the mediastream adapter
  // (ws_error / ws_closed-before-stop / slow_consumer / queue_overflow).
  // Stamping these as 'failed' keeps voice_sessions.outcome analytics
  // honest — otherwise infra regressions hide as caller abandonment.
  if (endedReason === 'transport_failure') {
    return 'failed';
  }

  // Successful dispatcher transfer: the /dial-result route stamps this
  // when DialCallStatus=completed/answered. The call IS resolved (a
  // human answered), but no real proposal_id was persisted so the
  // generic hasProposal/intent heuristics below would mis-classify as
  // 'dropped'. An explicit reason short-circuits that.
  if (endedReason === 'transferred') {
    return 'completed';
  }

  if (finalState === 'escalating' || finalState === 'degraded') {
    if (context.escalationReason?.startsWith('system_failure:')) {
      return 'failed';
    }
    if (hasProposal) return 'callback_required';
    return 'escalated_to_human';
  }

  if (endedReason === 'caller_hangup') {
    if (!spoke) return 'dropped';
    if (hasProposal) return 'completed';
    return 'no_intent';
  }

  // U5 — 'max_call_duration': the absolute per-call cap ended the call.
  // Nothing broke, so it is classified like the other clean ends (from what
  // the caller achieved), never the infra 'failed' bucket the unknown-reason
  // default below falls to.
  if (
    endedReason === 'normal_close' ||
    endedReason === 'closed' ||
    endedReason === 'session_ended' ||
    endedReason === 'manual_end' ||
    endedReason === 'idle_timeout' ||
    endedReason === 'max_call_duration'
  ) {
    if (hasProposal) return 'completed';
    if (intentSet) return 'completed';
    if (spoke) return 'no_intent';
    return 'dropped';
  }

  return 'failed';
}

/**
 * #351 — canonical adapter from a live `VoiceSession` to {@link
 * deriveCallOutcome}'s pure-function shape. Replaces two independent
 * `deriveOutcomeFromSession` duplicates that used to live on
 * `telephony/twilio-adapter.ts` (private method, called by the now-dead
 * `stampCallOutcomeByCallSid`) and `ai/voice-turn/create-voice-turn-
 * processor.ts` (used by `runSummary` to stamp `voice_recordings.outcome`).
 *
 * Those duplicates read ONLY `session.machine.currentContext
 * .escalationReason`, `proposalIds`, and transcript caller-speech — they
 * never saw the FSM's `endedReason` string this module's `deriveCallOutcome`
 * keys off. That gap was a real, silently-diverging bug: an abuse-terminated
 * call's `escalationReason` starts with `abuse_detected`, which the old
 * duplicates mapped to `'failed'`, while `deriveCallOutcome`'s endedReason
 * check (`endedReason.startsWith('abuse_detected:')`) maps the SAME call to
 * `'escalated_to_human'` — so `voice_sessions.outcome` and
 * `voice_recordings.outcome` disagreed for every abuse-terminated call.
 *
 * `finalizeTerminatedSession` (the processor's own terminal hook) always
 * runs before either duplicate's call site and stashes both
 * `session.terminalOutcome` and `session.terminalReason` on the session
 * BEFORE `runSummary` (or the dead `stampCallOutcomeByCallSid`) runs. So:
 *
 *  - When `session.terminalOutcome` is already stashed, return it verbatim
 *    — this is not just an optimization, it GUARANTEES
 *    `voice_recordings.outcome` agrees with the `voice_sessions.outcome`
 *    already persisted for the same call, closing the disagreement above.
 *  - Otherwise (e.g. a session finalized outside this hook, or a unit test
 *    constructing a session directly), fall back to computing it fresh from
 *    the same inputs `finalizeTerminatedSession` would have used —
 *    `session.terminalReason` for `endedReason`, defaulting to
 *    `'session_ended'` (itself one of `deriveCallOutcome`'s recognized
 *    "normal close" reasons, matching the old duplicates' behavior when no
 *    escalation was in progress).
 */
export function deriveCallOutcomeFromSession(session: VoiceSession): CallOutcome {
  if (session.terminalOutcome) return session.terminalOutcome;
  return deriveCallOutcome({
    finalState: session.machine.currentState,
    endedReason: session.terminalReason ?? 'session_ended',
    context: session.machine.currentContext,
    transcript: session.transcript,
    proposalIds: session.proposalIds,
  });
}
