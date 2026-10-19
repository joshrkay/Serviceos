/**
 * The registry's lines tell the owner they can answer out loud ("Say "first" or
 * "second" to pick."). On a turn where nothing listens (the microphone was
 * refused, the browser cannot, or the server has no transcription) that would be
 * a promise the screen cannot keep, so the shell drops just that part. Only the
 * say-first-or-second wording is touched: "Say a caller tells me …" (suppose) and
 * "until you say so" stay.
 */
const Q = `["“”]`;
const SENTENCE = new RegExp(`\\s*Say ${Q}first${Q} or ${Q}second${Q}[^.]*\\.`, 'g');
const CLAUSE = new RegExp(`,\\s*or say ${Q}first${Q} or ${Q}second${Q}`, 'gi');

export function withoutListeningPromise<T extends string | undefined>(line: T): T {
  if (!line) return line;
  return line.replace(SENTENCE, '').replace(CLAUSE, '').trim() as T;
}
