/**
 * A3 / T2-F03 — the bounded reprompt→escalate ladder for a turn the
 * transport could not hear: an empty utterance (silence) or a final whose
 * acoustic STT confidence is below {@link MIN_STT_CONFIDENCE}.
 *
 * #1601 step 2 — the one copy. Three transports carried the same rules
 * (Gather `runLowSttConfidenceGatherLadder`, the processor's
 * `runLowSttConfidenceLadder` — ported "verbatim" by #962 — and media-streams
 * `recoverFromLowSttConfidence`). Each keeps ONLY what is genuinely its own:
 * the streak store (Gather's per-adapter map, the processor's per-processor
 * map, media-streams' per-leg counter), how the spoken line is rendered
 * (TwiML, side effects, a streamed recovery line) and the terminal finalize.
 * The rules live here:
 *   - a missing / non-finite / at-or-above-floor confidence is HIGH — a turn
 *     is never blocked on absent data (Twilio omits `Confidence` for some
 *     valid recognitions; Deepgram defaults it to 1);
 *   - strike 1 … N-1 reprompts with {@link LOW_STT_CONFIDENCE_REPROMPT_COPY};
 *   - strike N ({@link MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS}) ends the ladder
 *     by the CAPPING strike's cause (LCR-02): low confidence → the FSM's
 *     `system_failure`, whose `notify_oncall` parks a `<Dial>`, the
 *     no-one-available message, or nothing ({@link parkedHandoffKind});
 *     silence (a pocket dial, a dead line) → a voicemail or a call-us-back
 *     line, never a page. No terminal line promises an undeliverable transfer;
 *   - a good (dispatched) turn clears the streak (the callers own that).
 * Silence and low confidence share ONE streak, so a caller alternating the
 * two still terminates at N.
 */
import type { SideEffect } from '../../agents/customer-calling/types';
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import {
  renderTtsText,
  sessionLanguage,
  LOW_STT_CONFIDENCE_REPROMPT_COPY,
  HANDOFF_UNAVAILABLE_COPY,
  SILENCE_CLOSING_COPY,
} from '../../agents/customer-calling/tts-copy';
import { recordVoiceError, type VoiceErrorChannel } from '../../../analytics/posthog';

/**
 * A3 — minimum acoustic STT confidence for a final transcript to be
 * dispatched into the turn pipeline. Below this the caller is asked to repeat
 * instead. A misheard turn acted on as if correct is worse than one extra
 * reprompt (e.g. "cancel" dispatched from a misheard "confirm").
 *
 * 0.5 is a conservative default: Deepgram Nova-3's acoustic confidence for
 * ordinary, clearly-heard speech is typically well above 0.7-0.8, while a
 * genuinely garbled/crosstalk/very-noisy-line utterance tends to fall well
 * below 0.5. Env-overridable per deployment (`VOICE_MIN_STT_CONFIDENCE`);
 * invalid/out-of-range overrides fall back to the default rather than
 * disabling or over-triggering the gate. ONE env var, ONE number, for every
 * surface (Gather's `Confidence` and Deepgram's `confidence` alike).
 */
export const MIN_STT_CONFIDENCE = ((): number => {
  const raw = process.env.VOICE_MIN_STT_CONFIDENCE;
  if (raw === undefined) return 0.5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.5;
})();

/**
 * A3 — after this many CONSECUTIVE low-confidence (or silent) turns the
 * surface stops reprompting and hands the caller off gracefully: a caller on
 * a persistently noisy/unintelligible line is not trapped in a "could you
 * repeat that" loop forever.
 */
export const MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS = 2;

/** The FSM `system_failure` reason (and terminal reason) at a low-confidence cap. */
export const LOW_STT_LADDER_TERMINAL_REASON = 'low_stt_confidence_max_retries' as const;

/** LCR-02 — the `end_session` / `voice_sessions.ended_reason` at a silence cap. */
export const SILENCE_LADDER_TERMINAL_REASON = 'silence_max_retries' as const;

/** True only for a real, finite confidence below the floor. */
export function isLowSttConfidence(confidence: number | undefined): boolean {
  return typeof confidence === 'number' && Number.isFinite(confidence) && confidence < MIN_STT_CONFIDENCE;
}

/** Why this strike happened: the caller said nothing, or said something we could not hear well. */
export type LowSttStrikeCause = 'silence' | 'low_confidence';

/** Which voicemail prompt a host's `<Record>` speaks (see `TwilioGatherAdapter.buildLadderVoicemailTwiml`). */
export type LadderVoicemailKind = 'silence' | 'no_handoff';

type Repeated = 'low_stt_confidence_repeated';
/**
 * reprompt: ask again (`copy` is the catalog key). system_failure: dispatch
 * the FSM's `system_failure` with `reason`. silence_close: offer a voicemail
 * where the host can deliver one, else speak `copy` and end with `reason`.
 */
export type LowSttLadderStep =
  | { kind: 'reprompt'; copy: string; errorKind: 'low_stt_confidence' }
  | { kind: 'system_failure'; reason: typeof LOW_STT_LADDER_TERMINAL_REASON; errorKind: Repeated }
  | { kind: 'silence_close'; copy: string; reason: typeof SILENCE_LADDER_TERMINAL_REASON; errorKind: Repeated };

/** The ladder's decision for the `streak`-th consecutive strike (1-based), keyed on the capping strike's cause. */
export function lowSttLadderStep(streak: number, cause: LowSttStrikeCause): LowSttLadderStep {
  if (streak < MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS) {
    return { kind: 'reprompt', copy: LOW_STT_CONFIDENCE_REPROMPT_COPY, errorKind: 'low_stt_confidence' };
  }
  return cause === 'silence'
    ? {
        kind: 'silence_close',
        copy: SILENCE_CLOSING_COPY,
        reason: SILENCE_LADDER_TERMINAL_REASON,
        errorKind: 'low_stt_confidence_repeated',
      }
    : { kind: 'system_failure', reason: LOW_STT_LADDER_TERMINAL_REASON, errorKind: 'low_stt_confidence_repeated' };
}

/**
 * What `notify_oncall` parked for the next TwiML response: a `<Dial>` (a
 * transfer is really being made — the only case the "connect you" line may be
 * spoken), the no-one-available message, or nothing at all.
 */
export function parkedHandoffKind(twiml: string | undefined): 'dial' | 'message' | 'none' {
  if (!twiml) return 'none';
  return /<Dial[\s>]/.test(twiml) ? 'dial' : 'message';
}

/**
 * A cap whose `notify_oncall` parked nothing, on a host that cannot take a
 * voicemail: say honestly that nobody could be reached, then end.
 */
export function noHandoffCloseEffects(session: Pick<VoiceSession, 'language'>, reason: string): SideEffect[] {
  return [ttsLine(session, HANDOFF_UNAVAILABLE_COPY), { type: 'end_session', payload: { reason } }];
}

/**
 * A streak store: consecutive strikes per live session. Keyed by the session
 * OBJECT so an entry is garbage-collected with the session — a caller who is
 * reprompted once and then hangs up (or is ended by the cap, the safety scan,
 * the cost cap…) leaves nothing behind. One per owner (Gather adapter,
 * processor); the owner clears it on every good turn.
 */
export type LowSttStreak = WeakMap<VoiceSession, number>;

export function createLowSttStreak(): LowSttStreak {
  return new WeakMap();
}

/** A good (dispatched, or confidence-absent) turn: the next strike is a fresh first one. */
export function clearLowSttStreak(streak: LowSttStreak, session: VoiceSession): void {
  streak.delete(session);
}

/**
 * Bump the session's streak, decide the step and build its effects. At the
 * cap the streak is cleared so a later call (should the session somehow
 * continue) starts a fresh ladder. The effects are:
 *   - reprompt → the reprompt line;
 *   - silence_close → the call-us-back line + `end_session` (a host that can
 *     deliver a voicemail replaces them with its `<Record>`);
 *   - system_failure → the FSM dispatch's own effects (audit, the "connect
 *     you" line, `notify_oncall`); the host executes them and then decides
 *     from {@link parkedHandoffKind} what the caller actually gets.
 * The caller renders the effects and finalizes a terminated session.
 */
export function runLowSttConfidenceLadder(
  session: VoiceSession,
  streak: LowSttStreak,
  cause: LowSttStrikeCause,
): { effects: SideEffect[]; step: LowSttLadderStep } {
  const strikes = (streak.get(session) ?? 0) + 1;
  const step = lowSttLadderStep(strikes, cause);
  if (step.kind === 'reprompt') {
    streak.set(session, strikes);
    return { effects: [ttsLine(session, step.copy)], step };
  }
  streak.delete(session);
  if (step.kind === 'silence_close') {
    return {
      effects: [ttsLine(session, step.copy), { type: 'end_session', payload: { reason: step.reason } }],
      step,
    };
  }
  return { effects: session.machine.dispatch({ type: 'system_failure', reason: step.reason }), step };
}

function ttsLine(session: Pick<VoiceSession, 'language'>, copy: string): SideEffect {
  return { type: 'tts_play', payload: { text: renderTtsText(copy, {}, sessionLanguage(session)) } };
}

/** OBS — the `voice_error` row for a step; IDs only, fired after the step is rendered. */
export function recordLowSttLadderError(
  step: LowSttLadderStep,
  channel: VoiceErrorChannel,
  ids: { callSid?: string | null; tenantId?: string | null },
): void {
  recordVoiceError({ errorKind: step.errorKind, channel, callSid: ids.callSid, tenantId: ids.tenantId });
}
