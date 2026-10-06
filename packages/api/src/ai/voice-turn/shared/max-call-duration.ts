/**
 * U5 — the absolute per-call duration cap: the numbers and the spoken shape
 * every phone transport shares.
 *
 * #1601 step 2 — the one copy. Gather (`maybeEndForMaxCallDuration`) checks
 * the session's age on every webhook turn — it has no timer of its own;
 * media streams (`armMaxCallDurationTimers` / `endForMaxCallDuration`) arms a
 * warn timer and a cut timer on the leg. Each keeps only its transport
 * mechanics; the limit, the warning lead, the wrap-up copy and the terminal
 * reason are defined here so both transports cut at the same wall-clock
 * limit and finalize `voice_sessions.terminal_reason = 'max_call_duration'`
 * — never the generic `failed`, because nothing broke.
 */
import type { SideEffect } from '../../agents/customer-calling/types';
import type { VoiceSession } from '../../agents/customer-calling/voice-session-store';
import {
  renderTtsText,
  MAX_CALL_DURATION_WRAP_UP_COPY,
  type SessionLanguage,
} from '../../agents/customer-calling/tts-copy';

/**
 * Default absolute per-call duration cap: 15 minutes, matching the intent of
 * the never-wired `DEFAULT_TELEPHONY_CAPS.maxDurationMs` this cap replaced.
 * Overridden per process by `VOICE_MAX_CALL_DURATION_MS` (wired into
 * `deps.maxCallDurationMs` of both adapters by app.ts).
 */
export const DEFAULT_MAX_CALL_DURATION_MS = 15 * 60 * 1000;

/**
 * How long before the cap the wrap-up line is spoken, so the caller is not
 * cut mid-sentence without warning. Limits shorter than twice this lead skip
 * the pre-warning and speak the wrap-up at the limit instead.
 */
export const MAX_CALL_DURATION_WRAP_UP_LEAD_MS = 30_000;

/** The `end_session` reason (and `voice_sessions.terminal_reason`) at the cap. */
export const MAX_CALL_DURATION_TERMINAL_REASON = 'max_call_duration' as const;

/** The configured limit, else the default. */
export function resolveMaxCallDurationMs(configured: number | undefined): number {
  return configured ?? DEFAULT_MAX_CALL_DURATION_MS;
}

/** The session's age in ms — the same elapsed-time basis `runSummary` uses. */
export function callAgeMs(session: Pick<VoiceSession, 'createdAt'>, now: number = Date.now()): number {
  return now - session.createdAt.getTime();
}

/** True once the call's age has reached `limitMs`. */
export function hasReachedMaxCallDuration(
  session: Pick<VoiceSession, 'createdAt'>,
  limitMs: number,
  now: number = Date.now(),
): boolean {
  return callAgeMs(session, now) >= limitMs;
}

/** When to speak the pre-warning, or null when the limit cannot fit one. */
export function maxCallDurationWarnDelayMs(limitMs: number): number | null {
  return limitMs >= MAX_CALL_DURATION_WRAP_UP_LEAD_MS * 2 ? limitMs - MAX_CALL_DURATION_WRAP_UP_LEAD_MS : null;
}

/** The synthetic `end_session` carrying the real reason. */
export function maxCallDurationEndEffect(): SideEffect {
  return { type: 'end_session', payload: { reason: MAX_CALL_DURATION_TERMINAL_REASON } };
}

/** Wrap-up line (in the session's language) + the end effect — Gather's speak-then-end turn. */
export function maxCallDurationEffects(session: Pick<VoiceSession, 'language'>): SideEffect[] {
  const lang: SessionLanguage = session.language === 'es' ? 'es' : 'en';
  return [
    { type: 'tts_play', payload: { text: renderTtsText(MAX_CALL_DURATION_WRAP_UP_COPY, {}, lang) } },
    maxCallDurationEndEffect(),
  ];
}
