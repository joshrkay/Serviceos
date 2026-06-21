/**
 * Shared transcript → prior-turns projection for the voice triage hooks.
 *
 * The voice session stores its transcript as flat `"speaker: text"` lines
 * (see VoiceSessionStore.appendTranscript). Both transports — Media Streams
 * (mediastream-adapter) and the legacy Gather path (twilio-adapter) — feed the
 * last few turns to the vulnerability-triage grader as `{ role, text }` pairs.
 * Keeping this projection in one place stops the two adapters from drifting.
 */
export function extractPriorTurns(
  transcript: ReadonlyArray<string>,
  n: number,
): ReadonlyArray<{ role: 'caller' | 'ai'; text: string }> {
  return [...transcript]
    .slice(-n)
    .map((line) => {
      const colonIdx = line.indexOf(': ');
      if (colonIdx === -1) return null;
      const speaker = line.slice(0, colonIdx);
      const text = line.slice(colonIdx + 2);
      const role: 'caller' | 'ai' = speaker === 'caller' ? 'caller' : 'ai';
      return { role, text };
    })
    .filter((t): t is { role: 'caller' | 'ai'; text: string } => t !== null);
}
