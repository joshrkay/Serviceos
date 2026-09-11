/**
 * Deterministic noise / mic-check detector for the operator voice turn.
 *
 * An operator opening a voice session says "um... hello?" or "testing, can
 * you hear me?" far more often than any classifier taxonomy admits. Today
 * that costs a full classify round-trip, comes back `unknown` at confidence
 * 0.1, burns a slot of the FSM's bounded retry budget, and marches the
 * session one step closer to an on-call page — for a mic check.
 *
 * `isNoiseUtterance` answers the one question that avoids all of it: *is
 * there anything here to classify at all?* It is used ONLY where a
 * mis-classification is harmless — `intent_capture` and `closing`, never on a
 * confirm or entity-disambiguation turn, where "ok" is a real answer to a
 * real question — and it is deliberately biased towards FALSE: anything that
 * carries a name, a number, or three real words is a request, and requests go
 * to the classifier.
 *
 * Pure, dependency-free, and unit-tested as a table (see
 * test/ai/agents/customer-calling/noise-filter.test.ts).
 */

/**
 * Tokens that carry no request on their own. Hesitation sounds, discourse
 * particles, greetings, and the mic-check vocabulary (including the spelled-
 * out counting an operator uses to test a microphone — a DIGIT never lands
 * here, see the digit guard in `isNoiseUtterance`).
 */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  // hesitation
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'er', 'erm', 'hmm', 'hm', 'hmmm',
  'mm', 'mmm', 'ah', 'ahh', 'oh', 'ohh', 'eh', 'huh',
  // discourse particles
  'like', 'so', 'well', 'okay', 'ok', 'kay', 'anyway', 'just',
  // greetings
  'hello', 'hallo', 'hi', 'hey', 'yo', 'hola',
  // mic check
  'testing', 'test', 'check', 'checking', 'mic', 'microphone', 'sound', 'audio',
  'one', 'two', 'three', 'four',
]);

/**
 * Whole utterances that are unmistakably a mic check even though their tokens
 * are ordinary words. Matched against the cleaned utterance AND against the
 * utterance with leading/trailing filler stripped, so "um, can you hear me?"
 * lands here too.
 */
const MIC_CHECK_PHRASES: ReadonlySet<string> = new Set([
  'can you hear me',
  'can you hear me now',
  'can anyone hear me',
  'do you hear me',
  'did you hear me',
  'are you there',
  'you there',
  'is anyone there',
  'anyone there',
  'anybody there',
  'is this on',
  'is this thing on',
  'is this working',
  'this thing on',
  'mic check',
  'sound check',
  'check check',
  'hello there',
  'hi there',
  'hey there',
  'hello hello',
  'there',
]);

/** Lowercase, drop everything that is not a letter/apostrophe, collapse spaces. */
function cleanForTokens(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when the utterance carries no request — filler only, a mic check, or
 * effectively nothing at all.
 *
 * FALSE (→ classify normally) for anything containing a digit, anything
 * naming a capitalised entity, and anything with three or more non-filler
 * tokens. Those are the three shapes a real operator request always has, and
 * a false positive here would swallow one.
 */
export function isNoiseUtterance(text: string): boolean {
  if (typeof text !== 'string') return false;

  // A digit is a reference — a time, an amount, a phone number, an invoice
  // number, a street number. Never noise, however short.
  if (/\d/.test(text)) return false;

  // Nothing to work with: empty, whitespace, punctuation, or a single stray
  // letter left by a clipped recognition.
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length <= 1) return true;

  const cleaned = cleanForTokens(text);
  if (cleaned.length === 0) return true;
  if (MIC_CHECK_PHRASES.has(cleaned)) return true;

  const tokens = cleaned.split(' ').filter((token) => token.length > 0);
  let start = 0;
  let end = tokens.length;
  while (start < end && FILLER_TOKENS.has(tokens[start])) start += 1;
  while (end > start && FILLER_TOKENS.has(tokens[end - 1])) end -= 1;
  const core = tokens.slice(start, end);

  // Every token was filler ("um...", "uh, so", "testing one two three").
  if (core.length === 0) return true;
  if (MIC_CHECK_PHRASES.has(core.join(' '))) return true;

  // ANY surviving non-filler token means the operator said something. This one
  // conservative rule subsumes both of the guards the register cares about —
  // a customer-ish proper noun ("Garcia") and three-or-more real words are
  // each, necessarily, a non-empty core — and it errs the safe way for the
  // one-and-two-word requests in between ("cancel", "next appointment"),
  // which reach the classifier exactly as they do today.
  return false;
}
