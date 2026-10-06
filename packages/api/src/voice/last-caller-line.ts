/**
 * The caller's most recent line in a session transcript (`caller: <text>`
 * lines, newest last), or undefined when there is none or it is blank.
 * One walk for every consumer: the voice_clarification payload, the in-app
 * brand-voice fallback and the escalation context.
 */
export function lastCallerLine(transcript: readonly string[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const line = transcript[i]!;
    if (line.toLowerCase().startsWith('caller:')) {
      return line.slice('caller:'.length).trim() || undefined;
    }
  }
  return undefined;
}
