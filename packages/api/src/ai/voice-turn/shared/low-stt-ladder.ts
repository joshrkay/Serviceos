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
 *   - strike N ({@link MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS}) speaks the SAME
 *     escalation line VOX-35c uses and ends the session with
 *     {@link LOW_STT_LADDER_TERMINAL_REASON} — the line itself is the problem
 *     (noise, crosstalk, a bad connection), not a one-off blip;
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
  SPEECH_TURN_FAILURE_ESCALATION_COPY,
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

/** The `end_session` reason (and `voice_sessions.terminal_reason`) at the cap. */
export const LOW_STT_LADDER_TERMINAL_REASON = 'low_stt_confidence_max_retries' as const;

/** True only for a real, finite confidence below the floor. */
export function isLowSttConfidence(confidence: number | undefined): boolean {
  return typeof confidence === 'number' && Number.isFinite(confidence) && confidence < MIN_STT_CONFIDENCE;
}

export interface LowSttLadderStep {
  /** The cap was reached on this strike: speak the escalation line and end. */
  escalate: boolean;
  /** The catalog key to speak (localized by the caller's renderer). */
  copy: string;
  errorKind: 'low_stt_confidence' | 'low_stt_confidence_repeated';
}

/** The ladder's decision for the `streak`-th consecutive strike (1-based). */
export function lowSttLadderStep(streak: number): LowSttLadderStep {
  return streak >= MAX_CONSECUTIVE_LOW_CONFIDENCE_TURNS
    ? { escalate: true, copy: SPEECH_TURN_FAILURE_ESCALATION_COPY, errorKind: 'low_stt_confidence_repeated' }
    : { escalate: false, copy: LOW_STT_CONFIDENCE_REPROMPT_COPY, errorKind: 'low_stt_confidence' };
}

/** The side effects a step speaks, rendered in the session's language. */
export function lowSttLadderEffects(session: Pick<VoiceSession, 'language'>, step: LowSttLadderStep): SideEffect[] {
  const effects: SideEffect[] = [
    { type: 'tts_play', payload: { text: renderTtsText(step.copy, {}, sessionLanguage(session)) } },
  ];
  if (step.escalate) {
    effects.push({ type: 'end_session', payload: { reason: LOW_STT_LADDER_TERMINAL_REASON } });
  }
  return effects;
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
 * continue) starts a fresh ladder. The caller finalizes the terminated
 * session (when `step.escalate`) and renders the effects.
 */
export function runLowSttConfidenceLadder(
  session: VoiceSession,
  streak: LowSttStreak,
): { effects: SideEffect[]; step: LowSttLadderStep } {
  const strikes = (streak.get(session) ?? 0) + 1;
  const step = lowSttLadderStep(strikes);
  if (step.escalate) streak.delete(session);
  else streak.set(session, strikes);
  return { effects: lowSttLadderEffects(session, step), step };
}

/** OBS — the `voice_error` row for a step; IDs only, fired after the step is rendered. */
export function recordLowSttLadderError(
  step: LowSttLadderStep,
  channel: VoiceErrorChannel,
  ids: { callSid?: string | null; tenantId?: string | null },
): void {
  recordVoiceError({ errorKind: step.errorKind, channel, callSid: ids.callSid, tenantId: ids.tenantId });
}
