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
 * Detection: runs of 13–19 digits, optionally grouped by spaces, dashes,
 * commas or periods (how STT punctuates paused groups), that pass the Luhn
 * check. A run that is longer than one card (a
 * card followed by its CVV, a phone number spoken next to it) is searched for
 * the leftmost-longest Luhn-valid window of whole groups, so "4111 1111 1111
 * 1111 123" keeps the "123". Phone numbers (10–11 digits), integer cents and
 * short codes are never long enough on their own, and a window never starts
 * on a phone-shaped group sequence (a phone said straight before a zip code
 * would otherwise pass the Luhn check one time in ten). Non-Luhn runs are
 * left alone; the `scrubPii` residual detector flags those for review instead.
 *
 * Spoken digits: Whisper (the recording transcription worker, whose text
 * also goes to the correction model) and other STT can write a card read
 * aloud as words, "four one one one …", and a Spanish caller says "cuatro uno
 * uno uno …". Digit words count as digits (English zero/oh/o–nine, Spanish
 * cero–nueve, with "double"/"triple" and "doble"/"triple" repeats), and the
 * fillers said between groups ("and", "dash", "uh", "y", commas) may join
 * them. Digit words separated only by spaces are one spoken group; a comma, a filler or a
 * switch to written digits starts the next, so the Luhn check, the
 * phone-shape guard and the whole-group window search apply to a spoken run
 * as to written digits, and the original words are what get replaced. Any
 * other word ends a run, so "two hundred fifty dollars" or "one twenty" is
 * never read as digits. Between two groups of written digits only the
 * written separators count, as before.
 *
 * Written digits are searched first, exactly as the digit-only scrubber
 * searched them, and what that finds is kept: a number word said beside a
 * written card never shortens it (`runCards`). Everything read with digit
 * words keeps the rules that make ordinary numbers said aloud no "card"
 * (`cardShaped`): it starts like a payment card (2–6), holds no more
 * year-shaped groups than a card does, and is read in a card's groups where
 * it mixes words and digits.

 *
 * Deepgram's own `redact=pci` replaces a card with `[CREDIT_CARD_N]` on
 * English streams; that tag is mapped to the same marker so a recording is
 * flagged for prompt audio purge whichever layer caught the card.
 */

/** The marker every scrubbed card number becomes. */
export const CARD_NUMBER_PLACEHOLDER = '[card number]';

const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/** Deepgram's card tag (`redact=pci`), e.g. `[CREDIT_CARD_1]`. */
const DEEPGRAM_CARD_TAG = /\[CREDIT_CARD(?:_\d+)?\]/g;

/** A digit spoken as a word: English zero/oh/o–nine, Spanish cero–nueve. */
const DIGIT_WORDS: ReadonlyMap<string, string> = new Map([
  ['zero', '0'],
  ['oh', '0'],
  ['o', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
  ['cero', '0'],
  ['uno', '1'],
  ['dos', '2'],
  ['tres', '3'],
  ['cuatro', '4'],
  ['cinco', '5'],
  ['seis', '6'],
  ['siete', '7'],
  ['ocho', '8'],
  ['nueve', '9'],
]);

/** "double one" is 11, "triple uno" is 111. */
const REPEAT_WORDS: ReadonlyMap<string, number> = new Map([
  ['double', 2],
  ['doble', 2],
  ['triple', 3],
]);

/** Said between spoken groups ("four one one one and one one one one"). */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'and',
  'dash',
  'hyphen',
  'uh',
  'um',
  'y',
  'guion',
  'guión',
  'eh',
]);

/**
 * Most punctuation and fillers allowed between two groups of a spoken run.
 * Enough for ", uh, " or "… and"; a longer stretch is a different sentence.
 */
const MAX_JOINER_MARKS = 3;
const MAX_JOINER_FILLERS = 2;

/**
 * Words that say a card is what is being read out ("my card is", "the Visa",
 * "mi tarjeta", "can I pay"). A list of years read out falls into groups of
 * four as a card does, so a card with two year-like groups is caught only
 * where the card is mentioned (`maxYearShapedGroups`).
 */
const CARD_CUE = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:cards?|visa|master\s?card|amex|american\s+express|discover|credit|debit|cvv|cvc` +
    String.raw`|tarjetas?|cr[ée]dito|d[ée]bito|pay|paying|payment|pago|pagar)(?![\p{L}\p{M}])`,
  'iu',
);

/** True when `text` mentions a card or paying (the marker of a card already scrubbed does not count). */
function hasCardCue(text: string, placeholder: string): boolean {
  return CARD_CUE.test(text.split(placeholder).join(' ').split(CARD_NUMBER_PLACEHOLDER).join(' '));
}

/**
 * Cheap pre-check: text with neither a digit nor a digit word cannot hold a
 * card number, so most prose skips the tokenizer.
 */
const MAY_HOLD_DIGITS = new RegExp(String.raw`\d|\b(?:${[...DIGIT_WORDS.keys()].join('|')})\b`, 'i');

/**
 * A run of written digits, a word (letters), a run of spaces or tabs, or one
 * other character. Digits and letters are separate tokens so the digit path
 * keeps its own, ASCII-only boundary (`isAsciiLetter`).
 */
const TOKEN = /([0-9]+)|([\p{L}\p{M}]+)|([ \t]+)|([\s\S])/gu;

/**
 * Written digits glued to an ASCII letter are part of a longer token (an id,
 * a reference: "ab4111…cd") and never a card. A non-ASCII letter does not
 * count: "nº4111…", "4111…ª" or an accented word STT ran onto the digits
 * still hold a card, as they always did for the digit-only scrubber. A word
 * glued to digits on either side is part of that token too, so it is never
 * read as a digit word or a filler.
 */
function isAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}
function isAsciiDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

/** One of `, . -`, and the other punctuation STT writes at a pause. */
const MARK_CHARS: ReadonlySet<string> = new Set([',', '.', '-']);
const PAUSE_CHARS: ReadonlySet<string> = new Set(['–', '—', '…', ';', ':', '!', '?']);

type TokenKind =
  /** Written digits not touching an ASCII letter. */
  | 'num'
  /** A digit word, or a repeat word with the digit word it repeats. */
  | 'spoken'
  /** Spaces or tabs. */
  | 'space'
  /** One of `, . -`: how STT punctuates the pause between written groups. */
  | 'mark'
  /** Other punctuation STT writes at a pause: `– — … ; : ! ?`. */
  | 'pause'
  | 'filler'
  /** Anything else: it ends a run. */
  | 'other';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** The digits a `num` or `spoken` token stands for. */
  digits: string;
}

function tokenize(text: string): Token[] {
  const raw: Array<Token & { repeat?: number }> = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let kind: TokenKind = 'other';
    let digits = '';
    let repeat: number | undefined;
    if (m[1] !== undefined) {
      if (!isAsciiLetter(text[start - 1]) && !isAsciiLetter(text[end])) {
        kind = 'num';
        digits = m[1];
      }
    } else if (m[2] !== undefined) {
      if (!isAsciiDigit(text[start - 1]) && !isAsciiDigit(text[end])) {
        const word = m[2].toLowerCase();
        const spoken = DIGIT_WORDS.get(word);
        if (spoken !== undefined) {
          kind = 'spoken';
          digits = spoken;
        } else if (FILLER_WORDS.has(word)) {
          kind = 'filler';
        } else {
          repeat = REPEAT_WORDS.get(word);
        }
      }
    } else if (m[3] !== undefined) {
      kind = 'space';
    } else if (MARK_CHARS.has(m[0])) {
      kind = 'mark';
    } else if (PAUSE_CHARS.has(m[0])) {
      kind = 'pause';
    }
    raw.push({ kind, start, end, digits, repeat });
  }
  // A repeat word counts only with the digit word it repeats ("double check"
  // is two ordinary words).
  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const target = raw[i + 2];
    if (t.repeat !== undefined && raw[i + 1]?.kind === 'space' && target?.kind === 'spoken') {
      tokens.push({
        kind: 'spoken',
        start: t.start,
        end: target.end,
        digits: target.digits.repeat(t.repeat),
      });
      i += 2;
      continue;
    }
    tokens.push({ kind: t.kind, start: t.start, end: t.end, digits: t.digits });
  }
  return tokens;
}

function isDigitToken(t: Token | undefined): t is Token {
  return t !== undefined && (t.kind === 'num' || t.kind === 'spoken');
}

function isJoinerToken(t: Token): boolean {
  return t.kind === 'space' || t.kind === 'mark' || t.kind === 'pause' || t.kind === 'filler';
}

/**
 * Between two groups of WRITTEN digits only the original separator counts:
 * spaces, or one comma, period or dash with optional spaces around it
 * ("4111, 1111" from Twilio Gather, "5555 - 5555"). A spoken group on either
 * side also allows the fillers and pause punctuation a caller's speech
 * carries ("four one one one, uh, one one one one").
 */
function joinsGroups(left: Token, joiner: Token[], right: Token): boolean {
  if (left.kind === 'num' && right.kind === 'num') {
    const shape = joiner.map((t) => t.kind).join(' ');
    return (
      shape === 'space' ||
      shape === 'mark' ||
      shape === 'space mark' ||
      shape === 'mark space' ||
      shape === 'space mark space'
    );
  }
  let marks = 0;
  let fillers = 0;
  for (const t of joiner) {
    if (t.kind === 'mark' || t.kind === 'pause') marks++;
    else if (t.kind === 'filler') fillers++;
  }
  return marks <= MAX_JOINER_MARKS && fillers <= MAX_JOINER_FILLERS;
}

/** One digit token of a run (a written number, or one digit word) and its index in the token stream. */
interface DigitUnit {
  digits: string;
  token: number;
}

/**
 * One spoken or written group of a run: its digits and its digit tokens (one
 * for a written group, one per digit word for a spoken one).
 */
interface DigitGroup {
  digits: string;
  units: DigitUnit[];
  /** Written digits (one `num` token). */
  written: boolean;
  /**
   * Written, and joined to the written group before it by a written
   * separator: the two are one run to the digit-only search.
   */
  writtenJoin: boolean;
}

/** The digit tokens a window takes from one group. */
interface WindowPart {
  group: DigitGroup;
  units: readonly DigitUnit[];
}

/** What a window is checked against beyond its digits: whether the card is mentioned around it (`hasCardCue`). */
interface SearchContext {
  cardCue: boolean;
}

/**
 * Every payment card in PCI scope (Visa, Mastercard, Amex, Discover, JCB,
 * Diners, UnionPay) starts with 2–6. Required of every window that is not
 * written digits alone (`cardShaped`).
 */
const PAYMENT_CARD_FIRST_DIGIT = /^[2-6]/;

/**
 * Digit words said with no pause, 13 to 15 of them, are a phone number with
 * a zip or a house number run onto it far more often than a card: no card
 * issued today is 13 digits, a 14-digit one is a Diners Club International
 * (36) and a 15-digit one an Amex (34, 37). Read as one run of words, a phone
 * and zip passed the Luhn check one time in ten.
 */
function issuedAtLength(digits: string): boolean {
  if (digits.length === 15) return /^3[47]/.test(digits);
  if (digits.length === 14) return digits.startsWith('36');
  return digits.length >= 16;
}

/** 1900–2039: a year said in a list of them ("two oh one eight", "2006"). */
const YEAR_SHAPED = /^(?:19\d\d|20[0-3]\d)$/;

/**
 * How many of a window's groups of four may read as years. Two or more is a
 * list of years (equipment installed in 2005, 2006, 2007, 2014), which joined
 * in fours passes the Luhn check one time in ten. A real card has two only
 * rarely (about one in 1,700 read in fours), so two are allowed where the
 * card is mentioned (`SearchContext.cardCue`); three or more never.
 */
function maxYearShapedGroups(cardCue: boolean): number {
  return cardCue ? 2 : 1;
}

/**
 * The window's digits in the groups a card is read in: written digits as
 * written, and spoken groups split into fours where a word ends (a repeat
 * that straddles the end of a four, "one double one", makes the window not
 * `aligned`).
 */
function windowChunks(parts: readonly WindowPart[]): { chunks: string[]; aligned: boolean } {
  const chunks: string[] = [];
  let aligned = true;
  for (const { group, units } of parts) {
    if (group.written) {
      chunks.push(units.map((u) => u.digits).join(''));
      continue;
    }
    let chunk = '';
    for (const u of units) {
      chunk += u.digits;
      if (chunk.length >= 4) {
        if (chunk.length > 4) aligned = false;
        chunks.push(chunk);
        chunk = '';
      }
    }
    if (chunk) chunks.push(chunk);
  }
  return { chunks, aligned };
}

/** An Amex's groups (4-6-5) and a Diners Club's (4-6-4). */
const SIX_DIGIT_MIDDLE_GROUPS: ReadonlySet<string> = new Set(['4,6,5', '4,6,4']);

/**
 * Read in the groups a card is read in: fours with a last group of one to
 * four, or an Amex's 4-6-5 (a Diners Club's 4-6-4). Required of a window that
 * mixes digit words and written digits ("4111 one one one one, 1111 1111"),
 * so a number word said next to an order or tracking number does not make a
 * "card" of it.
 */
function groupedLikeACard(parts: readonly WindowPart[], chunks: readonly string[], aligned: boolean): boolean {
  if (SIX_DIGIT_MIDDLE_GROUPS.has(parts.map((p) => p.units.reduce((n, u) => n + u.digits.length, 0)).join(','))) {
    return true;
  }
  return aligned && chunks.slice(0, -1).every((c) => c.length === 4) && chunks[chunks.length - 1].length <= 4;
}

/**
 * The rules a window must keep, beyond the Luhn check and its length, unless
 * it is written digits alone (those keep exactly the digit-only scrubber's
 * rules). Any window with digit words in it must start like a payment card
 * (2–6) and hold no more
 * year-shaped groups of four than a card does (`maxYearShapedGroups`). Digit
 * words said as one unbroken run must be a length cards are issued in
 * (`issuedAtLength`). Words and written digits mixed must be read in a
 * card's groups (`groupedLikeACard`).
 */
function cardShaped(parts: readonly WindowPart[], run: string, ctx: SearchContext): boolean {
  const spoken = parts.some((p) => !p.group.written);
  if (!spoken) return true;
  if (!PAYMENT_CARD_FIRST_DIGIT.test(run)) return false;
  if (parts.length === 1 && spoken && !issuedAtLength(run)) return false;
  const { chunks, aligned } = windowChunks(parts);
  const mixed = spoken && parts.some((p) => p.group.written);
  if (mixed && !groupedLikeACard(parts, chunks, aligned)) return false;
  return chunks.filter((c) => YEAR_SHAPED.test(c)).length <= maxYearShapedGroups(ctx.cardCue);
}

/** A card number found: the token range it covers (digit tokens at both ends). */
interface CardHit {
  from: number;
  to: number;
}

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

/**
 * Number of groups, starting at `i`, that read as a North American phone
 * number: 3-3-4 ("602 555 0199", "602-555-0199", "six oh two, five five
 * five, oh one nine nine"), the same after a leading country code "1", or one
 * unbroken 10-digit (11 with a leading 1) group. Zero when the groups at `i`
 * are not phone-shaped.
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
 * A phone number read with its last digits in pairs ("siete ocho tres,
 * cuatro nueve ocho, cero cinco, cero nueve"): 3-3-2-2, 3-1-2-2-2, or a
 * Mexican number's five pairs. Searched for only where digit words are read
 * (`cardWindows`); the written path keeps `phoneGroupsAt` as it always had.
 */
const PHONE_SHAPES_IN_PAIRS: ReadonlyArray<readonly number[]> = [
  [3, 3, 2, 2],
  [3, 1, 2, 2, 2],
  [2, 2, 2, 2, 2],
];

function spokenPhoneGroupsAt(groups: string[], i: number): number {
  const phone = phoneGroupsAt(groups, i);
  if (phone > 0) return phone;
  const shape = PHONE_SHAPES_IN_PAIRS.find((lengths) => lengths.every((n, k) => groups[i + k]?.length === n));
  return shape?.length ?? 0;
}

/** The token range of groups `first`..`last`. */
function groupHit(groups: readonly DigitGroup[], first: number, last: number): CardHit {
  return { from: groups[first].units[0].token, to: groups[last].units[groups[last].units.length - 1].token };
}

/**
 * The leftmost-longest search over whole groups: from each group not inside a
 * phone number (`phoneAt`), every card-length window, longest first, the
 * first that passes the Luhn check and `accept` taken. Returns each card as
 * its first and last group.
 */
function wholeGroupCards(
  digits: string[],
  phoneAt: (groups: string[], i: number) => number,
  accept: (first: number, last: number, run: string) => boolean = () => true,
): Array<[number, number]> {
  const cards: Array<[number, number]> = [];
  let i = 0;
  while (i < digits.length) {
    const phone = phoneAt(digits, i);
    if (phone > 0) {
      // Kept verbatim; scanning resumes after it.
      i += phone;
      continue;
    }
    const windows: Array<{ end: number; run: string }> = [];
    let run = '';
    for (let j = i; j < digits.length; j++) {
      run += digits[j];
      if (run.length > MAX_PAN_DIGITS) break;
      if (run.length >= MIN_PAN_DIGITS) windows.push({ end: j, run });
    }
    const hit = windows.reverse().find((w) => isLuhnValid(w.run) && accept(i, w.end, w.run));
    if (hit) {
      cards.push([i, hit.end]);
      i = hit.end + 1;
    } else {
      i++;
    }
  }
  return cards;
}

/**
 * The cards in one run. Written digits come first: each stretch of written
 * groups joined by written separators is searched exactly as the digit-only
 * scrubber searched it, and what it finds is kept as found. A digit word said
 * beside a written card ("card number one: 5410 6952 7846 2767") joins its
 * run, and searched from that word a shorter window (the word and the first
 * three groups) passed the Luhn check one time in ten, which left the card's
 * last group in clear. The rest of the run (spoken groups, and written groups
 * no written card covers) is then searched with digit words
 * (`cardWindows`); it can add cards but never shorten one.
 */
function runCards(groups: DigitGroup[], cardCue: boolean): CardHit[] {
  const hits: CardHit[] = [];
  const taken = groups.map(() => false);
  for (let a = 0; a < groups.length; ) {
    if (!groups[a].written) {
      a++;
      continue;
    }
    let b = a + 1;
    while (b < groups.length && groups[b].writtenJoin) b++;
    for (const [first, last] of wholeGroupCards(groups.slice(a, b).map((g) => g.digits), phoneGroupsAt)) {
      hits.push(groupHit(groups, a + first, a + last));
      taken.fill(true, a + first, a + last + 1);
    }
    a = b;
  }
  for (let a = 0; a < groups.length; ) {
    if (taken[a]) {
      a++;
      continue;
    }
    let b = a + 1;
    while (b < groups.length && !taken[b]) b++;
    const rest = groups.slice(a, b);
    if (rest.reduce((n, g) => n + g.digits.length, 0) >= MIN_PAN_DIGITS) hits.push(...cardWindows(rest, cardCue));
    a = b;
  }
  return hits.sort((x, y) => x.from - y.from);
}

/**
 * The card numbers inside a stretch of a run that holds digit words: the
 * leftmost-longest Luhn-valid window of whole groups that keeps `cardShaped`,
 * never starting on a phone number (`spokenPhoneGroupsAt`).
 */
function cardWindows(groups: DigitGroup[], cardCue: boolean): CardHit[] {
  const ctx: SearchContext = { cardCue };
  const whole = (from: number, to: number): WindowPart[] =>
    groups.slice(from, to + 1).map((group) => ({ group, units: group.units }));
  return wholeGroupCards(groups.map((g) => g.digits), spokenPhoneGroupsAt, (from, to, run) =>
    cardShaped(whole(from, to), run, ctx),
  ).map(([first, last]) => groupHit(groups, first, last));
}

/**
 * Every card number in a token stream. A run is digit tokens joined by
 * group separators (`joinsGroups`); digit words separated only by spaces form
 * one spoken group, and anything else (a comma, a filler, a switch between
 * words and written digits) starts the next group.
 */
function findCardHits(tokens: Token[], cardCue: boolean): CardHit[] {
  const hits: CardHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isDigitToken(tokens[i])) {
      i++;
      continue;
    }
    const first = tokens[i];
    const groups: DigitGroup[] = [
      {
        digits: first.digits,
        units: [{ digits: first.digits, token: i }],
        written: first.kind === 'num',
        writtenJoin: false,
      },
    ];
    let last = i;
    for (;;) {
      let next = last + 1;
      while (next < tokens.length && isJoinerToken(tokens[next])) next++;
      const right = tokens[next];
      if (!isDigitToken(right)) break;
      const joiner = tokens.slice(last + 1, next);
      if (!joinsGroups(tokens[last], joiner, right)) break;
      const group = groups[groups.length - 1];
      const sameSpokenGroup =
        tokens[last].kind === 'spoken' && right.kind === 'spoken' && joiner.every((t) => t.kind === 'space');
      const unit = { digits: right.digits, token: next };
      if (sameSpokenGroup) {
        group.digits += right.digits;
        group.units.push(unit);
      } else {
        const written = right.kind === 'num';
        groups.push({
          digits: right.digits,
          units: [unit],
          written,
          writtenJoin: written && tokens[last].kind === 'num',
        });
      }
      last = next;
    }
    const total = groups.reduce((n, g) => n + g.digits.length, 0);
    if (total >= MIN_PAN_DIGITS) hits.push(...runCards(groups, cardCue));
    i = last + 1;
  }
  return hits;
}

/** Called once per redacted card: the matched text and its offset in the input. */
type CardRedactionListener = (matched: string, offset: number) => void;

/**
 * Replace every Luhn-valid card number, written as digits or spoken as words
 * (and Deepgram's card tag), in `text`. The original span is what is
 * replaced, so "four one one one, …" becomes one marker. `onRedact`
 * (optional) sees each replaced span with its offset.
 */
export function redactCardNumbers(
  text: string,
  placeholder: string = CARD_NUMBER_PLACEHOLDER,
  onRedact?: CardRedactionListener,
): string {
  if (!text) return text;
  const tagged = text.replace(DEEPGRAM_CARD_TAG, placeholder);
  if (!MAY_HOLD_DIGITS.test(tagged)) return tagged;
  const tokens = tokenize(tagged);
  const hits = findCardHits(tokens, hasCardCue(tagged, placeholder));
  if (hits.length === 0) return tagged;
  let out = '';
  let pos = 0;
  for (const hit of hits) {
    const start = tokens[hit.from].start;
    const end = tokens[hit.to].end;
    onRedact?.(tagged.slice(start, end), start);
    out += tagged.slice(pos, start) + placeholder;
    pos = end;
  }
  return out + tagged.slice(pos);
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
