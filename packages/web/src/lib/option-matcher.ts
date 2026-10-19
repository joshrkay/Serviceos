/**
 * The first/second option matcher for the v3 onboarding shell (U4).
 *
 * Every v3 turn shows two options. When the owner answers out loud, the shell
 * matches the final transcript to one of them here, on the client, before any
 * server call: "first", "the second one", "number two", "b", or words from an
 * option's label ("hold it", "eighty-nine"). Anything unclear returns null and
 * the owner taps instead; a guess is never made.
 *
 * Pure and deterministic: no DOM, no network, no randomness.
 */
import type { OnboardingOptionKey } from '@ai-service-os/shared';

export interface MatchableOption {
  key: OnboardingOptionKey;
  /** The card label exactly as rendered (tokens already filled). */
  label: string;
}

/** The turn's two options in display order: the first one, then the second. */
export type MatchableOptions = readonly [MatchableOption, MatchableOption];

export interface OptionMatch {
  key: OnboardingOptionKey;
  by: 'ordinal' | 'letter' | 'label';
  /** 0..1. Ordinals and letters are near-certain; label matches carry their score. */
  confidence: number;
}

const ORDINAL_CONFIDENCE = 0.95;
const LETTER_CONFIDENCE = 0.9;
/** A label match needs this score, and this lead over the other option. */
const LABEL_MIN_SCORE = 0.5;
const LABEL_MIN_MARGIN = 0.2;
/** The price turn's labels differ only in their numbers, so numbers count double. */
const NUMBER_WEIGHT = 2;

/** Hesitations and politeness dropped wherever they appear. */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'hmm', 'hm', 'mm', 'please']);

/** Words after which "one" is a pronoun ("the second one"), not the number 1. */
const ONE_CARRIERS = new Set([
  'the', 'that', 'this', 'which', 'other', 'first', 'second', '1st', '2nd',
  'top', 'bottom', 'former', 'latter', 'last',
]);

const ORDINAL_FIRST = new Set(['first', '1st', 'top', 'former']);
const ORDINAL_SECOND = new Set(['second', '2nd', 'bottom', 'latter', 'last']);

/**
 * Words that turn an answer around ("not the first"). "no" is not one: on the
 * existing-number turn "no" is the answer itself.
 */
const NEGATIONS = new Set(['not', 'dont', 'never', 'neither', 'nor', 'isnt', 'wasnt', 'wouldnt', 'doesnt', 'nope']);

/** Lowercase words with punctuation removed; "$1,200" -> "1200", "don't" -> "dont", "eighty-nine" -> "eighty nine". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Maps, not object literals, so "constructor" or "toString" in a transcript is never a number.
const UNITS = new Map(Object.entries({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }));
const TEENS = new Map(
  Object.entries({
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  }),
);
const TENS = new Map(
  Object.entries({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }),
);

/** Reads a number below 100 at `i` ("nine", "fifteen", "eighty nine"); null when none starts there. */
function belowHundred(t: string[], i: number): { value: number; next: number } | null {
  const w = t.at(i);
  if (w === undefined) return null;
  const tens = TENS.get(w);
  if (tens !== undefined) {
    const unit = UNITS.get(t[i + 1] ?? '');
    return unit !== undefined ? { value: tens + unit, next: i + 2 } : { value: tens, next: i + 1 };
  }
  const small = TEENS.get(w) ?? UNITS.get(w);
  return small !== undefined ? { value: small, next: i + 1 } : null;
}

/** Reads one spoken number (0-999) at `i`, including "a hundred and five" and the price shorthand "one twenty nine". */
function spokenNumber(t: string[], i: number): { value: number; next: number } | null {
  const w = t[i];
  if (w === 'zero') return { value: 0, next: i + 1 };
  const lead = w === 'a' && t[i + 1] === 'hundred' ? { value: 1, next: i + 1 } : belowHundred(t, i);
  if (!lead) return null;
  if (t[lead.next] === 'hundred' && lead.value < 10) {
    let j = lead.next + 1;
    if (t[j] === 'and' && belowHundred(t, j + 1)) j += 1;
    const rest = belowHundred(t, j);
    return rest ? { value: lead.value * 100 + rest.value, next: rest.next } : { value: lead.value * 100, next: j };
  }
  // "one twenty nine" / "one fifteen" / "one oh five": a single digit, then the last two digits.
  if (UNITS.has(w)) {
    const n = t[lead.next] ?? '';
    const rest = TENS.has(n) || TEENS.has(n) ? belowHundred(t, lead.next) : null;
    if (rest) return { value: lead.value * 100 + rest.value, next: rest.next };
    const ohUnit = n === 'oh' || n === 'zero' ? UNITS.get(t[lead.next + 1] ?? '') : undefined;
    if (ohUnit !== undefined) return { value: lead.value * 100 + ohUnit, next: lead.next + 2 };
  }
  return lead;
}

/** The utterance's words, cleaned: fillers out, pronoun "one" out, trailing "the" out, number words as digits. */
function clean(text: string): string[] {
  const raw = words(text).filter((w) => !FILLERS.has(w));
  const noPronoun = raw.filter((w, i) => !((w === 'one' || w === 'ones') && i > 0 && ONE_CARRIERS.has(raw[i - 1])));
  while (noPronoun.length > 0 && noPronoun[noPronoun.length - 1] === 'the') noPronoun.pop();
  const out: string[] = [];
  for (let i = 0; i < noPronoun.length; ) {
    const n = spokenNumber(noPronoun, i);
    if (n) {
      out.push(String(n.value));
      i = n.next;
    } else {
      out.push(noPronoun[i]);
      i += 1;
    }
  }
  return out;
}

/**
 * "first", "the second one", "number two", "the other one". A word that also
 * appears in one of the labels is label content, not an ordinal.
 */
function ordinalKey(t: string[], options: MatchableOptions, labelWords: ReadonlySet<string>): OnboardingOptionKey | null {
  let first = false;
  let second = false;
  t.forEach((w, i) => {
    if (labelWords.has(w)) return;
    const prev = t[i - 1];
    const counted = prev === 'number' || prev === 'option';
    if (ORDINAL_FIRST.has(w) || (w === '1' && counted)) first = true;
    if (ORDINAL_SECOND.has(w) || (w === '2' && counted) || (w === 'other' && prev === 'the')) second = true;
  });
  if (t.length === 1 && t[0] === '1') first = true;
  if (t.length === 1 && t[0] === '2') second = true;
  if (first === second) return null;
  return first ? options[0].key : options[1].key;
}

/** Words that carry no choice: dropped from the answer and the labels before scoring. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'it', 'its', 'to', 'on', 'for', 'me', 'my', 'i', 'im', 'ill', 'id',
  'you', 'your', 'of', 'and', 'or', 'then', 'with', 'is', 'at', 'in', 'them', 'if',
  'we', 'our', 'us', 'they', 'be', 'that', 'this', 'so', 'go', 'do', 'lets', 'take',
  'want', 'like', 'would', 'one', 'option', 'number', 'dollar', 'dollars', 'buck', 'bucks',
]);

const isNumber = (w: string): boolean => /^\d+$/.test(w);

/** "weekdays" and "weekday" are the same word to an owner. */
function stem(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !isNumber(w) ? w.slice(0, -1) : w;
}

function contentWords(t: string[]): Set<string> {
  return new Set(t.filter((w) => !STOP_WORDS.has(w)).map(stem));
}

function weight(words: ReadonlySet<string>): number {
  let total = 0;
  for (const w of words) total += isNumber(w) ? NUMBER_WEIGHT : 1;
  return total;
}

/** One letter off for words of five letters or more ("colect", "saterday"); numbers must match exactly. */
function closeEnough(a: string, b: string): boolean {
  if (a === b) return true;
  if (isNumber(a) || isNumber(b) || a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Overlap coefficient: the shared weight over the smaller side's weight, so a short answer and a long one both score fairly. */
function labelScore(said: ReadonlySet<string>, label: ReadonlySet<string>): number {
  const denominator = Math.min(weight(said), weight(label));
  if (denominator === 0) return 0;
  let shared = 0;
  for (const w of said) {
    for (const l of label) {
      if (closeEnough(w, l)) {
        shared += isNumber(w) ? NUMBER_WEIGHT : 1;
        break;
      }
    }
  }
  return shared / denominator;
}

function labelMatch(t: string[], labels: readonly string[][], options: MatchableOptions): OptionMatch | null {
  const said = contentWords(t);
  const [scoreA, scoreB] = labels.map((l) => labelScore(said, contentWords(l)));
  const best = Math.max(scoreA, scoreB);
  if (best < LABEL_MIN_SCORE || Math.abs(scoreA - scoreB) < LABEL_MIN_MARGIN) return null;
  return { key: scoreA > scoreB ? options[0].key : options[1].key, by: 'label', confidence: best };
}

/** "a", "b", "option a": only as the whole answer, so "a pay link" is never the letter a. */
function letterKey(t: string[], options: MatchableOptions): OnboardingOptionKey | null {
  const letter = t.length === 1 ? t[0] : t.length === 2 && t[0] === 'option' ? t[1] : null;
  if (letter === 'a') return options[0].key;
  if (letter === 'b' || letter === 'bee') return options[1].key;
  return null;
}

export function matchOption(transcript: string, options: MatchableOptions): OptionMatch | null {
  const t = clean(transcript);
  if (t.length === 0) return null;
  const labels = options.map((o) => clean(o.label));
  const labelWords = new Set(labels.flat());
  // A negation the labels do not share ("don't" is in the emergency turn's label) means no guess.
  if (t.some((w) => NEGATIONS.has(w) && !labelWords.has(w))) return null;

  const letter = letterKey(t, options);
  if (letter) return { key: letter, by: 'letter', confidence: LETTER_CONFIDENCE };
  const ordinal = ordinalKey(t, options, labelWords);
  if (ordinal) return { key: ordinal, by: 'ordinal', confidence: ORDINAL_CONFIDENCE };
  return labelMatch(t, labels, options);
}
