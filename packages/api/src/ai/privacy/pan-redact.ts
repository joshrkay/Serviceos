/**
 * PRIV-3 — card-number (PAN) scrubber.
 *
 * spec/RIVET_COMMS_SPEC.md:94: "no card number should ever reach a
 * transcript. If one does ... detect and redact rather than assume compliance
 * holds." Nothing asks a caller for a card (payments go through pay links),
 * but a caller can recite one unprompted, and before this module the digits
 * flowed verbatim into the stored transcript turns, the session transcript,
 * the LLM provider, `ai_runs` and the trace exporter.
 *
 * One pure function, applied at the chokepoints rather than per store:
 *   - `callerTranscriptText` (every stored caller turn and everything derived
 *     from it),
 *   - user-role text in `LLMGateway.complete` (provider payload + ai_runs
 *     snapshot + trace export), and the cache-hit snapshot,
 *   - `redactTextForExport` (trace export, all roles),
 *   - `scrubPii` (knowledge-chunk corpus) and the recording transcription
 *     worker's `sanitizeTranscript`.
 *
 * Detection: runs of 13–19 digits, optionally grouped by single spaces or
 * dashes, that pass the Luhn check. A run that is longer than one card (a
 * card followed by its CVV, a phone number spoken next to it) is searched for
 * the leftmost-longest Luhn-valid window of whole groups, so "4111 1111 1111
 * 1111 123" keeps the "123". Phone numbers (10–11 digits), integer cents and
 * short codes are never long enough on their own, and a window never starts
 * on a phone-shaped group sequence (a phone said straight before a zip code
 * would otherwise pass the Luhn check one time in ten). Non-Luhn runs are
 * left alone; the `scrubPii` residual detector flags those for review instead.
 *
 * Deepgram's own `redact=pci` replaces a card with `[CREDIT_CARD_N]` on
 * English streams; that tag is mapped to the same marker so a recording is
 * flagged for prompt audio purge whichever layer caught the card.
 */

/** The marker every scrubbed card number becomes. */
export const CARD_NUMBER_PLACEHOLDER = '[card number]';

const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/** Digit groups joined by single spaces or dashes, not touching letters/digits. */
const DIGIT_RUN = /(?<![0-9A-Za-z])\d+(?:[ -]\d+)*(?![0-9A-Za-z])/g;
const GROUP_SEPARATOR = /[ -]/;

/** Deepgram's card tag (`redact=pci`), e.g. `[CREDIT_CARD_1]`. */
const DEEPGRAM_CARD_TAG = /\[CREDIT_CARD(?:_\d+)?\]/g;

/** Luhn (mod 10) check over a string of digits. */
function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Called once per redacted card: the matched text and its offset in the input. */
type CardRedactionListener = (matched: string, offset: number) => void;

/**
 * Number of groups, starting at `i`, that read as a North American phone
 * number: 3-3-4 ("602 555 0199", "602-555-0199"), the same after a leading
 * country code "1", or one unbroken 10-digit (11 with a leading 1) group.
 * Zero when the groups at `i` are not phone-shaped.
 *
 * A phone said straight before another number ("602 555 0199 85006") is a
 * 13–19 digit grouped run, and about one in ten of those passes the Luhn
 * check, so without this the callback number was replaced and the call's
 * audio was deleted early. Cards are read in fours (Amex 4-6-5) or unbroken,
 * never in a phone's 3-3-4, so a window may not START on a phone; a card said
 * after the phone is still found.
 */
function phoneGroupsAt(groups: string[], i: number): number {
  const len = (k: number): number => groups[i + k]?.length ?? 0;
  const g0 = groups[i];
  if (g0.length === 10 || (g0.length === 11 && g0.startsWith('1'))) return 1;
  if (len(0) === 3 && len(1) === 3 && len(2) === 4) return 3;
  if (g0 === '1' && len(1) === 3 && len(2) === 3 && len(3) === 4) return 4;
  return 0;
}

/**
 * Redact the card numbers inside one digit run. Works on whole groups so a
 * redaction never splits a spoken group in half.
 */
function redactRun(
  run: string,
  runOffset: number,
  placeholder: string,
  onRedact?: CardRedactionListener,
): string {
  const groups = run.split(GROUP_SEPARATOR);
  const separators = run.match(/[ -]/g) ?? [];
  // Character offset of each group inside the run.
  const starts: number[] = [];
  let pos = 0;
  for (let g = 0; g < groups.length; g++) {
    starts.push(pos);
    pos += groups[g].length + 1;
  }
  const out: string[] = [];
  let i = 0;
  while (i < groups.length) {
    const phone = phoneGroupsAt(groups, i);
    if (phone > 0) {
      // Kept verbatim, separators included; scanning resumes after it.
      const last = i + phone - 1;
      for (let g = i; g <= last; g++) {
        out.push(groups[g]);
        if (g + 1 < groups.length) out.push(separators[g]);
      }
      i = last + 1;
      continue;
    }
    // Leftmost-longest: every window of whole groups starting at i that is
    // card-length, longest first.
    const windows: Array<{ end: number; digits: string }> = [];
    let digits = '';
    for (let j = i; j < groups.length; j++) {
      digits += groups[j];
      if (digits.length > MAX_PAN_DIGITS) break;
      if (digits.length >= MIN_PAN_DIGITS) windows.push({ end: j, digits });
    }
    const hit = windows.reverse().find((w) => isLuhnValid(w.digits));
    const last = hit ? hit.end : i;
    if (hit) {
      const from = starts[i];
      const to = starts[last] + groups[last].length;
      onRedact?.(run.slice(from, to), runOffset + from);
      out.push(placeholder);
    } else {
      out.push(groups[i]);
    }
    if (last + 1 < groups.length) out.push(separators[last]);
    i = last + 1;
  }
  return out.join('');
}

/**
 * Replace every Luhn-valid card number (and Deepgram's card tag) in `text`.
 * `onRedact` (optional) sees each replaced digit run with its offset.
 */
export function redactCardNumbers(
  text: string,
  placeholder: string = CARD_NUMBER_PLACEHOLDER,
  onRedact?: CardRedactionListener,
): string {
  if (!text) return text;
  return text
    .replace(DEEPGRAM_CARD_TAG, placeholder)
    .replace(DIGIT_RUN, (run: string, offset: number) => {
      const digitCount = run.replace(/[ -]/g, '').length;
      return digitCount < MIN_PAN_DIGITS ? run : redactRun(run, offset, placeholder, onRedact);
    });
}

/** True when already-scrubbed text carries the card-number marker. */
export function containsCardNumber(text: string): boolean {
  return text.includes(CARD_NUMBER_PLACEHOLDER);
}

/** The structural slice of an LLM message this module rewrites. */
interface ScrubbableMessage {
  role: string;
  content: string;
  parts?: ReadonlyArray<unknown>;
}

function redactTextPart(part: unknown): unknown {
  if (
    part !== null &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  ) {
    const text = (part as { text: string }).text;
    const redacted = redactCardNumbers(text);
    return redacted === text ? part : { ...(part as Record<string, unknown>), text: redacted };
  }
  return part;
}

/**
 * Card numbers out of every USER-role message (content and text parts).
 * User-role text is where caller and operator speech lands; system and
 * assistant text is passed through as written. Returns new message objects
 * only where something changed.
 */
export function redactCardNumbersInUserMessages<M extends ScrubbableMessage>(messages: M[]): M[] {
  return messages.map((m) => {
    if (m.role !== 'user') return m;
    const content = typeof m.content === 'string' ? redactCardNumbers(m.content) : m.content;
    const parts = Array.isArray(m.parts) ? m.parts.map(redactTextPart) : m.parts;
    const partsChanged = Array.isArray(m.parts) && parts!.some((p, i) => p !== m.parts![i]);
    if (content === m.content && !partsChanged) return m;
    return { ...m, content, ...(partsChanged ? { parts } : {}) };
  });
}
