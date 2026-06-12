/**
 * appendAgentTts — shared helper used wherever the voice turn appends the
 * last agent TTS line to the session transcript.
 *
 * This block appeared verbatim in three places:
 *   1. createVoiceTurnProcessor — pending-dialogue branch (approval turn)
 *   2. createVoiceTurnProcessor — intent branch (voice approval intent)
 *   3. TwilioGatherAdapter.finalizeTwiml — normal + transfer paths
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
