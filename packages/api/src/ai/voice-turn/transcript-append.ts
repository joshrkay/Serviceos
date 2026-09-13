/**
 * appendAgentTts — shared helper used wherever the voice turn appends the
 * last agent TTS line to the session transcript.
 *
 * This block appeared verbatim in five places:
 *   1. createVoiceTurnProcessor — pending-dialogue branch (approval turn)
 *   2. createVoiceTurnProcessor — intent branch (voice approval intent)
 *   3. createVoiceTurnProcessor — fallback/default branch
 *   4. TwilioGatherAdapter.finalizeTwiml — normal path
 *   5. TwilioGatherAdapter.finalizeTwiml — transfer path
 *
 * Extracted here (inside the `ai/voice-turn` package) so the helper has no
 * dependency on `telephony/` — avoiding the circular import that would arise
 * if it lived in `telephony/`. twilio-adapter already imports from
 * `ai/voice-turn`, so this is import-graph safe.
 */
import type { SideEffect } from '../agents/customer-calling/types';

/**
 * Minimal slice of VoiceSessionStore needed by this helper (avoids importing
 * the full store class, which carries many unrelated methods).
 */
export interface AppendTranscriptStore {
  appendTranscript(
    sessionId: string,
    entry: { speaker: 'caller' | 'agent'; text: string; ts: number },
  ): void;
}

/** Stands in for a spoken money-approval challenge. See `callerTranscriptText`. */
export const REDACTED_CHALLENGE_TEXT = '[redacted: voice-approval challenge]';

/**
 * Minimal slice of the voice session needed to decide whether the caller's
 * utterance is a spoken approval challenge.
 */
export interface ChallengeAwareSession {
  pendingVoiceApproval?: { stage?: string };
}

/**
 * The text to store for a caller utterance — redacted when the session is
 * awaiting a spoken money-approval challenge (#850).
 *
 * Money- and irreversible-class voice approvals require a spoken challenge
 * (`ai/tasks/proposal-approval-task.ts`). It is a STATIC per-tenant secret
 * spoken aloud on a recorded call, so without this every money approval writes
 * another copy of it into the transcript — and into everything derived from
 * one. Encryption at rest protects the store; it does nothing about a secret
 * whose exposure grows with each use.
 *
 * Keyed on the dialogue STAGE, never on the shape of the utterance: matching
 * on "looks like a code" would both leak (an owner who says "the code is
 * 4821") and over-redact (a genuine "4821 Bridgewater Road"). Callers append
 * the utterance BEFORE `handlePendingVoiceApproval` consumes the turn, so the
 * stage still reflects the prompt the owner is answering.
 *
 * A placeholder is stored rather than nothing, so the trail still shows a turn
 * occurred — a silently shorter transcript is its own reporting bug.
 */
export function callerTranscriptText(
  session: ChallengeAwareSession | undefined,
  spoken: string,
): string {
  return session?.pendingVoiceApproval?.stage === 'challenge' ? REDACTED_CHALLENGE_TEXT : spoken;
}

/**
 * Find the last `tts_play` side effect and append its text as an `agent`
 * transcript entry on `sessionId`.  No-op when no `tts_play` is present or
 * the text is not a string.
 */
export function appendAgentTts(
  store: AppendTranscriptStore,
  sessionId: string,
  sideEffects: ReadonlyArray<SideEffect>,
): void {
  const last = [...sideEffects].reverse().find((e) => e.type === 'tts_play');
  if (last && typeof last.payload.text === 'string') {
    store.appendTranscript(sessionId, {
      speaker: 'agent',
      text: last.payload.text,
      ts: Date.now(),
    });
  }
}
