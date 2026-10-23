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
 *     worker's `sanitizeTranscript`,
 *   - and, for a card split across turns, `VoiceSessionStore.appendTranscript`
 *     over the session's last few caller turns (`redactCardNumbersAcrossTurns`),
 *     read again over the stored rows by the recording transcript hook
 *     (`redactCardNumbersInCallTurns`).
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
 * cero–nueve, with "double"/"triple" and "doble"/"triple" repeats; a bare
 * "o" beside Spanish digit words is Spanish "or" and ends the run), so do
 * tens and teens read in pairs, each its two digits ("forty-one eleven",
 * "cuarenta y uno once"; "once" and "quince" only beside Spanish number
 * words), and the fillers said between groups ("and", "dash", "uh", "er",
 * "y", "este", "pues", commas, a line break) may join them. Digit words
 * separated only by spaces are one spoken group; a comma, a filler or a
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
 * (`cardShaped`): it starts like a payment card (2–6) and is a length a card
 * is issued at for its first digits, holds no more year-shaped groups than a
 * card does, is read in a card's groups where it mixes words and digits or
 * holds pairs, and, holding pairs (which lists of times, years, prices and
 * house numbers do too) or said with no pause at a phone number and zip's
 * length, has the card named within a few words of it (`CARD_CUE`: a card
 * word, never talk of paying).
 *
 * Words have no space to lose: written, STT puts one between a card and the
 * CVV or expiry said after it ("4012888888881881 0427"); read as words with
 * no pause, they are one spoken group longer than any card. Where the
 * whole-group search finds nothing, a card may also be cut out of a spoken
 * group between two words, keeping the CVV or expiry after it (or a stray
 * "oh" before it); see `cutCardWindows` for the rules that keep long runs of
 * words that are not a card (a phone number and zip, a tracking number)
 * untouched.
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

/** A digit spoken as a word in English: zero/oh/o–nine. */
const ENGLISH_DIGIT_WORDS: ReadonlyMap<string, string> = new Map([
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
]);

/** A digit spoken as a word in Spanish: cero–nueve. */
const SPANISH_DIGIT_WORDS: ReadonlyMap<string, string> = new Map([
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

const DIGIT_WORDS: ReadonlyMap<string, string> = new Map([...ENGLISH_DIGIT_WORDS, ...SPANISH_DIGIT_WORDS]);

/**
 * A card's groups of four are often read in pairs ("forty-one eleven"): a ten
 * or a teen is its two digits. English tens join the unit after them with a
 * hyphen or a space ("forty-one", "forty one"); alone they end in 0
 * ("twenty" is 20).
 */
const ENGLISH_PAIR_WORDS: ReadonlyMap<string, string> = new Map([
  ['ten', '10'],
  ['eleven', '11'],
  ['twelve', '12'],
  ['thirteen', '13'],
  ['fourteen', '14'],
  ['fifteen', '15'],
  ['sixteen', '16'],
  ['seventeen', '17'],
  ['eighteen', '18'],
  ['nineteen', '19'],
]);
const ENGLISH_TENS: ReadonlyMap<string, string> = new Map([
  ['twenty', '2'],
  ['thirty', '3'],
  ['forty', '4'],
  ['fifty', '5'],
  ['sixty', '6'],
  ['seventy', '7'],
  ['eighty', '8'],
  ['ninety', '9'],
]);

/**
 * The same in Spanish: diez–diecinueve and veinte–veintinueve are one word
 * each (with or without the accent STT may drop); treinta–noventa join the
 * unit after them with "y" ("cuarenta y uno").
 */
const SPANISH_PAIR_WORDS: ReadonlyMap<string, string> = new Map([
  ['diez', '10'],
  ['once', '11'],
  ['doce', '12'],
  ['trece', '13'],
  ['catorce', '14'],
  ['quince', '15'],
  ['dieciséis', '16'],
  ['dieciseis', '16'],
  ['diecisiete', '17'],
  ['dieciocho', '18'],
  ['diecinueve', '19'],
  ['veinte', '20'],
  ['veintiuno', '21'],
  ['veintidós', '22'],
  ['veintidos', '22'],
  ['veintitrés', '23'],
  ['veintitres', '23'],
  ['veinticuatro', '24'],
  ['veinticinco', '25'],
  ['veintiséis', '26'],
  ['veintiseis', '26'],
  ['veintisiete', '27'],
  ['veintiocho', '28'],
  ['veintinueve', '29'],
]);
const SPANISH_TENS: ReadonlyMap<string, string> = new Map([
  ['treinta', '3'],
  ['cuarenta', '4'],
  ['cincuenta', '5'],
  ['sesenta', '6'],
  ['setenta', '7'],
  ['ochenta', '8'],
  ['noventa', '9'],
]);

/** Every Spanish number word (for the "o" and "once" rules in `tokenize`). */
const SPANISH_NUMBER_WORDS: ReadonlySet<string> = new Set([
  ...SPANISH_DIGIT_WORDS.keys(),
  ...SPANISH_PAIR_WORDS.keys(),
  ...SPANISH_TENS.keys(),
]);

/**
 * Spanish number words that are also English words ("I called once", "quince
 * jam"): numbers only beside another Spanish number word.
 */
const SPANISH_ONLY_BESIDE_SPANISH: ReadonlySet<string> = new Set(['once', 'quince']);

/** A unit digit (1–9) that may follow a ten: "forty-one", "cuarenta y uno". */
const ENGLISH_UNITS: ReadonlySet<string> = new Set(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']);
const SPANISH_UNITS: ReadonlySet<string> = new Set(['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve']);

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
  'er',
  'ah',
  'y',
  'guion',
  'guión',
  'eh',
  'este',
  'pues',
]);

/**
 * Most punctuation and fillers allowed between two groups of a spoken run
 * (or across a turn boundary). Enough for ", uh, " or "1111..." then
 * ", 1111"; a longer stretch is a different sentence.
 */
const MAX_JOINER_MARKS = 4;
const MAX_JOINER_FILLERS = 2;

/**
 * A short acknowledgement a caller may open the turn that reads on with,
 * answering the agent's "go on" ("okay, 1111 1111", "vale, …").
 */
const ACKNOWLEDGEMENTS = [
  'okay',
  'ok',
  'so',
  'alright',
  'right',
  'yes',
  'yeah',
  'then',
  'sorry',
  'mm-hmm',
  'mhm',
  'uh-huh',
  'vale',
  'bueno',
  'sí',
  // "sí" as STT often writes it.
  'si',
  'entonces',
  'luego',
];

/** Spaces and the punctuation STT writes at a pause. */
const BREAK = String.raw`[\s,.;:!?…–—-]`;

/**
 * A turn of nothing but one to three acknowledgements or fillers ("okay",
 * "um", "sí", "okay, um."): a pause the caller says as a turn of its own,
 * read past for a mention of the card before it (`turnsCue`).
 */
const PAUSE_TURN = new RegExp(
  String.raw`^${BREAK}*(?:(?:${[...ACKNOWLEDGEMENTS, ...FILLER_WORDS].join('|')})(?:${BREAK}+|$)){1,3}$`,
  'iu',
);

/**
 * How a caller may open the turn that reads on (`redactCardNumbersAcrossTurns`
 * only): up to two fillers or acknowledgements, then optionally which group
 * comes next ("the next four are", "and the last four digits are", "los
 * últimos cuatro son"; captured), whose count is not one of the card's
 * digits. Inside a turn these words end a run as they always did.
 */
const CONTINUATION_LEAD_IN = new RegExp(
  String.raw`^${BREAK}*(?:(?:${[...ACKNOWLEDGEMENTS, ...FILLER_WORDS].join('|')})${BREAK}+){0,2}` +
    String.raw`(?:((?:the\s+)?(?:next|last|final|other|remaining)\s+(?:one|two|three|four|five|six|[1-6])` +
    String.raw`(?:\s+(?:digits?|numbers?))?(?:\s+(?:are|is))?` +
    String.raw`|(?:(?:los|las)\s+)?(?:siguientes|próximos|proximos|últimos|ultimos|otros)\s+(?:uno|dos|tres|cuatro|cinco|seis|[1-6])` +
    String.raw`(?:\s+(?:dígitos|digitos|números|numeros))?(?:\s+(?:son|es))?)${BREAK}+)?`,
  'iu',
);

/**
 * A count phrase that reads on from digits already given ("the next four
 * are", "los siguientes cuatro"): the caller is reading out one long number
 * group by group, which counts as a mention of the card. "The last four" is
 * not: it is also how a caller answers "what are the last four of your
 * account?".
 */
const READS_ON = /(?<![\p{L}\p{M}])(?:next|other|remaining|siguientes|próximos|proximos|otros)(?![\p{L}\p{M}])/iu;

/**
 * Words that say a card is what is being read out: the card itself ("card",
 * "card number", "credit card", "debit card", "Discover card"; "tarjeta",
 * "número de tarjeta", "tarjeta de crédito"), a card network (Visa,
 * Mastercard, Amex, American Express) or a card's security code (CVV, CVC).
 * A rule that needs the card mentioned (a card read in pairs, two
 * year-shaped groups, a window over turns with a turn of four digits or
 * fewer) takes nothing else: callers talk about paying ("can I pay now",
 * "quiero pagar"), store credit, debit or cash and "discovering" what is
 * wrong while they give gate codes, years and prices, and the agent about
 * payment links and the approval card on screen (`APPROVAL_CARD_COPY`). Read
 * only near the digits (`textCue`, `turnsCue`).
 */
const CARD_CUE = /(?<![\p{L}\p{M}])(?:cards?|tarjetas?|visa|master\s?card|amex|american\s+express|cvv|cvc)(?![\p{L}\p{M}])/iu;
/** Every mention in a text (only ever read through `matchAll`, which never moves its `lastIndex`). */
const CARD_CUES = new RegExp(CARD_CUE.source, 'giu');

/**
 * The agent's own copy for the proposal card on screen ("Tap the card to
 * approve", "open the card to fill them in"; tts-copy's
 * voice_approval_refusal and inapp_incomplete_draft): it names no payment
 * card, and on an owner-line call it is said right before amounts and codes.
 */
const APPROVAL_CARD_COPY =
  /(?<![\p{L}\p{M}])(?:(?:tap|open)\s+the\s+card\s+to\s+(?:approve|fill)|(?:toque|abra)\s+la\s+tarjeta\s+para\s+(?:aprobar|completar(?:l[oa]s)?))(?![\p{L}\p{M}])/giu;

/** True when `text` names a card. The marker of a card already scrubbed, and the approval card, do not count. */
function mentionsCard(text: string, placeholder: string): boolean {
  return CARD_CUE.test(blankNonMentions(text, placeholder));
}

/**
 * `text` with what names no payment card blanked out, offsets kept: every
 * card marker ("[card number]" holds the word) and the approval-card copy.
 */
function blankNonMentions(text: string, placeholder: string): string {
  let out = text;
  for (const marker of new Set([placeholder, CARD_NUMBER_PLACEHOLDER])) {
    if (marker) out = out.split(marker).join(' '.repeat(marker.length));
  }
  return out.replace(APPROVAL_CARD_COPY, (copy) => ' '.repeat(copy.length));
}

/**
 * How far from the digits, in words, a mention of the card in the same text
 * may be (`textCue`): "my card number is uh let me grab it okay it is …" is
 * ten. Further away it is another sentence, and in a whole
 * call's transcript (the transcription worker scrubs one text) a card
 * mentioned at the start says nothing of numbers read minutes later.
 */
const MAX_CUE_DISTANCE_WORDS = 12;

/**
 * What can stand for digits, and at most how many: written digits (each),
 * a digit word (one), a ten or a teen (two), a repeat word ("triple", three).
 * `candidateRegions` counts these to find the stretches of a text that could
 * hold 13 digits at all; nothing else is tokenized.
 */
const REPEAT_WORD_DIGITS = 3;
const DIGIT_LIKE = new RegExp(
  String.raw`\d+|(?<![\p{L}\p{M}])(?:${[
    ...DIGIT_WORDS.keys(),
    ...ENGLISH_PAIR_WORDS.keys(),
    ...ENGLISH_TENS.keys(),
    ...SPANISH_PAIR_WORDS.keys(),
    ...SPANISH_TENS.keys(),
    ...REPEAT_WORDS.keys(),
  ].join('|')})(?![\p{L}\p{M}])`,
  'giu',
);

/**
 * A digit or a number word anywhere in a text (`DIGIT_LIKE`, one match: no
 * `g` flag to carry a `lastIndex`): what a card marker in a stored row's
 * redacted text stands for (the recording hook's `fitsRedaction`).
 */
export const HOLDS_DIGITS = new RegExp(DIGIT_LIKE.source, 'iu');

function digitsAtMost(said: string): number {
  if (isAsciiDigit(said[0])) return said.length;
  const word = said.toLowerCase();
  if (DIGIT_WORDS.has(word)) return 1;
  return REPEAT_WORDS.has(word) ? REPEAT_WORD_DIGITS : 2;
}

/** Words of context kept around a stretch: past the furthest a mention of the card counts (`textCue`). */
const CONTEXT_WORDS = MAX_CUE_DISTANCE_WORDS + 2;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{M}\p{N}]/u.test(ch);
}

/**
 * The stretches of `text` that could hold a card, each with enough words
 * around it for a mention of the card, cut at word boundaries: digit tokens
 * chained by gaps a run can span, adding up to 13 digits or more. Text with
 * none (most prose, and prompts whose numbers are dates, prices and times) is
 * never tokenized, and long text is tokenized only around its numbers. Each
 * stretch is searched exactly as the whole text would be: its runs and the
 * words a mention is read in all lie inside it.
 */
function candidateRegions(text: string): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  let first = -1;
  let last = -1;
  let digits = 0;
  const flush = (): void => {
    if (digits < MIN_PAN_DIGITS) return;
    let start = first;
    for (let words = 0; start > 0 && words < CONTEXT_WORDS; words++) {
      while (start > 0 && !isWordChar(text[start - 1])) start--;
      while (start > 0 && isWordChar(text[start - 1])) start--;
    }
    let end = last;
    for (let words = 0; end < text.length && words < CONTEXT_WORDS; words++) {
      while (end < text.length && !isWordChar(text[end])) end++;
      while (end < text.length && isWordChar(text[end])) end++;
    }
    const previous = regions.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else regions.push({ start, end });
  };
  for (const m of text.matchAll(DIGIT_LIKE)) {
    const at = m.index;
    if (last < 0 || !withinRunGap(text, last, at)) {
      flush();
      first = at;
      digits = 0;
    }
    last = at + m[0].length;
    digits += digitsAtMost(m[0]);
  }
  flush();
  return regions;
}

/**
 * True when what is between two digit tokens could join them into one run:
 * only whitespace, the punctuation STT writes at a pause, and fillers, no
 * more of them than `joinsGroups` ever allows. Any other word or character
 * ends a run, so a stretch never spans prose ("10/22 about the heater in
 * 2015").
 */
function withinRunGap(text: string, from: number, to: number): boolean {
  let marks = 0;
  let fillers = 0;
  for (let i = from; i < to; ) {
    const ch = text[i];
    if (isSpace(text.charCodeAt(i))) {
      i++;
    } else if (MARK_CHARS.has(ch) || PAUSE_CHARS.has(ch)) {
      if (++marks > MAX_JOINER_MARKS) return false;
      i++;
    } else {
      let j = i;
      while (j < to && isWordChar(text[j])) j++;
      if (j === i || !FILLER_WORDS.has(text.slice(i, j).toLowerCase()) || ++fillers > MAX_JOINER_FILLERS) return false;
      i = j;
    }
  }
  return true;
}

function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x2028 || code === 0x2029;
}

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

/** One of `, . -`, and the other punctuation STT writes at a pause (a line break included). */
const MARK_CHARS: ReadonlySet<string> = new Set([',', '.', '-']);
const PAUSE_CHARS: ReadonlySet<string> = new Set(['–', '—', '…', ';', ':', '!', '?', '\r', '\n']);

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
  /** What a continuation turn opens with before reading on (`CONTINUATION_LEAD_IN`). */
  | 'lead'
  /** The boundary between two caller turns (`redactCardNumbersAcrossTurns`). */
  | 'turn'
  /** Anything else: it ends a run. */
  | 'other';

interface Token {
  kind: TokenKind;
  /** Which text (turn) the token is in; offsets are within that text. */
  seg: number;
  start: number;
  end: number;
  /** The digits a `num` or `spoken` token stands for. */
  digits: string;
  /** A `spoken` ten or teen, read as its two digits. */
  pair?: boolean;
}

function tokenize(text: string, seg = 0): Token[] {
  const raw: Array<Token & { repeat?: number; word?: string; tens?: 'en' | 'es' }> = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let kind: TokenKind = 'other';
    let digits = '';
    let repeat: number | undefined;
    let word: string | undefined;
    let tens: 'en' | 'es' | undefined;
    let pair = false;
    if (m[1] !== undefined) {
      if (!isAsciiLetter(text[start - 1]) && !isAsciiLetter(text[end])) {
        kind = 'num';
        digits = m[1];
      }
    } else if (m[2] !== undefined) {
      if (!isAsciiDigit(text[start - 1]) && !isAsciiDigit(text[end])) {
        word = m[2].toLowerCase();
        const spoken = DIGIT_WORDS.get(word) ?? ENGLISH_PAIR_WORDS.get(word) ?? SPANISH_PAIR_WORDS.get(word);
        const ten = ENGLISH_TENS.get(word) ?? SPANISH_TENS.get(word);
        if (spoken !== undefined) {
          kind = 'spoken';
          digits = spoken;
          pair = spoken.length === 2;
        } else if (ten !== undefined) {
          kind = 'spoken';
          digits = `${ten}0`;
          pair = true;
          tens = ENGLISH_TENS.has(word) ? 'en' : 'es';
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
      // A line break between groups is a pause too (a transcript that wraps).
      kind = 'pause';
    }
    raw.push({ kind, seg, start, end, digits, pair, repeat, word, tens });
  }
  // A repeat word counts only with the digit word it repeats ("double check"
  // is two ordinary words).
  const tokens: Token[] = [];
  /** The number word each spoken token reads (for "double one", "one"; for "forty-one", "forty"). */
  const words: Array<string | undefined> = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const target = raw[i + 2];
    // A ten and the unit after it are one pair: "forty-one", "forty one",
    // "cuarenta y uno".
    const unit =
      t.tens === 'en' && (raw[i + 1]?.kind === 'space' || text[raw[i + 1]?.start ?? -1] === '-')
        ? (target?.word !== undefined && ENGLISH_UNITS.has(target.word) ? 2 : 0)
        : t.tens === 'es' && raw[i + 1]?.kind === 'space' && raw[i + 2]?.word === 'y' && raw[i + 3]?.kind === 'space'
          ? (raw[i + 4]?.word !== undefined && SPANISH_UNITS.has(raw[i + 4].word!) ? 4 : 0)
          : 0;
    if (unit > 0) {
      const last = raw[i + unit];
      tokens.push({ kind: 'spoken', seg, start: t.start, end: last.end, digits: t.digits[0] + last.digits, pair: true });
      words.push(t.word);
      i += unit;
      continue;
    }
    if (t.repeat !== undefined && raw[i + 1]?.kind === 'space' && target?.kind === 'spoken') {
      tokens.push({
        kind: 'spoken',
        seg,
        start: t.start,
        end: target.end,
        digits: target.digits.repeat(t.repeat),
        pair: target.pair,
      });
      words.push(target.word);
      i += 2;
      continue;
    }
    tokens.push({ kind: t.kind, seg, start: t.start, end: t.end, digits: t.digits, pair: t.pair });
    words.push(t.kind === 'spoken' ? t.word : undefined);
  }
  // A bare "o" is "oh" beside English digit words, but Spanish "or" beside
  // Spanish ones ("… nueve nueve o cuatro ocho …", "… uno o sea"), where it
  // ends the run instead of joining two numbers with a zero. "once" and
  // "quince" are English words too, and numbers only beside Spanish ones.
  const besideSpanish = (i: number, step: number): boolean => {
    let k = i + step;
    while (k >= 0 && k < tokens.length && isJoinerToken(tokens[k])) k += step;
    return SPANISH_NUMBER_WORDS.has(words[k] ?? '');
  };
  // Decided against the tokens as read, then applied.
  const notNumbers: number[] = [];
  words.forEach((word, i) => {
    if (word !== 'o' && !SPANISH_ONLY_BESIDE_SPANISH.has(word ?? '')) return;
    const spanish = besideSpanish(i, -1) || besideSpanish(i, 1);
    if (word === 'o' ? spanish : !spanish) notNumbers.push(i);
  });
  for (const i of notNumbers) tokens[i] = { ...tokens[i], kind: 'other', digits: '', pair: false };
  return tokens;
}

function isDigitToken(t: Token | undefined): t is Token {
  return t !== undefined && (t.kind === 'num' || t.kind === 'spoken');
}

function isJoinerToken(t: Token): boolean {
  return (
    t.kind === 'space' ||
    t.kind === 'mark' ||
    t.kind === 'pause' ||
    t.kind === 'filler' ||
    t.kind === 'lead' ||
    t.kind === 'turn'
  );
}

/**
 * Between two groups of WRITTEN digits only the original separator counts:
 * spaces, or one comma, period or dash with optional spaces around it
 * ("4111, 1111" from Twilio Gather, "5555 - 5555"). A spoken group on either
 * side also allows the fillers and pause punctuation a caller's speech
 * carries ("four one one one, uh, one one one one"). A turn boundary is the
 * pause itself, so beside it the punctuation STT writes at either side ("4111
 * 1111..." then "1111"), fillers ("4111 1111" then "um, 1111 1111") and what
 * the next turn opens with ("okay, 1111", "the next four are 1111") are
 * allowed between written groups too.
 */
function joinsGroups(left: Token, joiner: Token[], right: Token): boolean {
  const spokenSide = left.kind === 'spoken' || right.kind === 'spoken';
  if (!spokenSide && !joiner.some((t) => t.kind === 'turn')) {
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
    else if (t.kind === 'filler' || t.kind === 'lead') fillers++;
  }
  return marks <= MAX_JOINER_MARKS && fillers <= MAX_JOINER_FILLERS;
}

/**
 * One digit token of a run (a written number, a digit word, or a ten or teen
 * read as a pair) and its index in the token stream.
 */
interface DigitUnit {
  digits: string;
  token: number;
  /** A ten or a teen, read as its two digits ("forty-one", "once"). */
  pair: boolean;
}

/**
 * One spoken or written group of a run: its digits, its turn and its digit
 * tokens (one for a written group, one per digit word for a spoken one).
 */
interface DigitGroup {
  digits: string;
  seg: number;
  units: DigitUnit[];
  /** Written digits (one `num` token). */
  written: boolean;
  /**
   * Written, and joined to the written group before it by a written
   * separator inside one turn: the two are one run to the digit-only search.
   */
  writtenJoin: boolean;
}

/** The digit tokens a window takes from one group (all of them, or the part a cut keeps). */
interface WindowPart {
  group: DigitGroup;
  units: readonly DigitUnit[];
}

/**
 * Whether the card is mentioned near a window (`CARD_CUE`): `near(from, to)`
 * for the window over tokens `from`..`to`. One text reads a mention within
 * `MAX_CUE_DISTANCE_WORDS` of the digits (`textCue`); turns read one in the
 * card's own turns or right around them (`turnsCue`).
 */
interface CardCue {
  near(from: number, to: number): boolean;
}

/**
 * What a window is checked against beyond its digits: the turns of the run
 * that are themselves a phone number, and where the card is mentioned.
 */
interface SearchContext {
  phoneTurns: ReadonlySet<number>;
  cue: CardCue;
}

/** A word, a number or a word glued to one ("4111" and "okay" are one each). */
const WORDS = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * How many words token `t` of `text` reads as (`textCue`): a number, a digit
 * word, a filler or another word is one, what a continuation turn opens with
 * ("okay, so", "the next four are") is its words, and spaces, punctuation and
 * a turn boundary are none.
 */
function wordsIn(text: string, t: Token): number {
  switch (t.kind) {
    case 'num':
    case 'spoken':
    case 'filler':
      return 1;
    case 'other':
      return /[\p{L}\p{N}]/u.test(text.charAt(t.start)) ? 1 : 0;
    case 'lead':
      return text.slice(t.start, t.end).match(WORDS)?.length ?? 0;
    default:
      return 0;
  }
}

/**
 * The card's mentions in one text, read against its tokens: `near` is a
 * mention within `MAX_CUE_DISTANCE_WORDS` words (written numbers, digit
 * words and other words; spaces and punctuation are no word) before the
 * window's first digit or after its last. Across turns each turn is one such
 * text (`turnsCue`), which also reads how far its last mention is from its end
 * and how many words come before a token. Found only when first asked.
 */
interface TextMentions extends CardCue {
  /** Words after the text's last mention to its end; undefined when it names no card. */
  wordsAfterLastMention(): number | undefined;
  /** Words before token `i`. */
  wordsBefore(i: number): number;
}

function textCue(text: string, tokens: readonly Token[], placeholder: string): TextMentions {
  let mentions: Array<{ first: number; last: number }> | undefined;
  let words: number[] = [];
  const locate = (): Array<{ first: number; last: number }> => {
    if (mentions) return mentions;
    mentions = [];
    // words[i]: how many words come before token i.
    words = new Array<number>(tokens.length + 1);
    words[0] = 0;
    for (let i = 0; i < tokens.length; i++) words[i + 1] = words[i] + wordsIn(text, tokens[i]);
    const tokenAt = (offset: number): number => {
      let lo = 0;
      let hi = tokens.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tokens[mid].start <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    for (const m of blankNonMentions(text, placeholder).matchAll(CARD_CUES)) {
      const start = m.index;
      mentions.push({ first: tokenAt(start), last: tokenAt(start + m[0].length - 1) });
    }
    return mentions;
  };
  return {
    near(from, to) {
      // Mentions are in text order and never overlap, so only two can be the
      // nearest: the last one starting at or before the window's end (it
      // overlaps the window, or is the closest before it) and the one after
      // it. A binary search, not a walk over every mention: a text naming the
      // card next to each of thousands of cards would be quadratic.
      const found = locate();
      let lo = 0;
      let hi = found.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (found[mid].first <= to) lo = mid + 1;
        else hi = mid;
      }
      const before = found[lo - 1];
      const after = found[lo];
      return (
        (before !== undefined &&
          (before.last >= from || words[from] - words[before.last + 1] <= MAX_CUE_DISTANCE_WORDS)) ||
        (after !== undefined && words[after.first] - words[to + 1] <= MAX_CUE_DISTANCE_WORDS)
      );
    },
    wordsAfterLastMention() {
      const last = locate().at(-1);
      return last === undefined ? undefined : words[tokens.length] - words[last.last + 1];
    },
    wordsBefore(i) {
      locate();
      return words[i];
    },
  };
}

/**
 * Every payment card in PCI scope (Visa, Mastercard, Amex, Discover, JCB,
 * Diners, UnionPay) starts with 2–6. Required of every window that is not
 * written digits inside one turn (`cardShaped`).
 */
const PAYMENT_CARD_FIRST_DIGIT = /^[2-6]/;

/**
 * Diners Club International's ranges (300–305, 3095, 36, 38–39): a card from
 * any of them is issued at 14 digits (`DINERS_CLUB_14`), or 16–19 (the
 * networks' 14-digit test numbers start 305, 36 and 38).
 */
const DINERS_CLUB = /^(?:30[0-5]|3095|36|3[89])/;

/**
 * A Diners Club's own length. Read as words in groups no card is read in
 * (3-3-6-2), or with no pause (`MIN_UNBROKEN_SPOKEN_DIGITS`), it needs the
 * card named (`cardShaped`).
 */
const DINERS_CLUB_14 = 14;

/**
 * Diners Club International's main range, the only one a 14 read as words
 * with no pause at all is taken from (`cardShaped`): 300–305 and 38–39 start
 * area codes (301–305, 380–399), and a phone number there read straight on
 * into four more digits passed the Luhn check one time in ten, with the card
 * named near it. From those ranges a Diners Club's 14 is read in its groups,
 * cut with its CVV or expiry run on, or over turns.
 */
const UNBROKEN_DINERS_CLUB = /^36/;

/**
 * The lengths a card is issued at for its first digits (the networks' IIN
 * ranges): American Express (34, 37) 15; Diners Club International
 * (`DINERS_CLUB`) 14 or 16–19 (15 is an Amex's length alone); JCB
 * (3528–3589) 16–19; Visa (4) 13, 16 or 19; Mastercard (51–55, 2221–2720)
 * and Mir (2200–2204) 16; Maestro (other 5s) and Discover, UnionPay, RuPay
 * and Maestro (6) 16–19. Any other start is no card. Required of every window
 * that is not written digits inside one turn (`cardShaped`): a 13–19 digit
 * run of house numbers, years, codes or a reference number passes the Luhn
 * check one time in ten whatever its length, and joined from several turns,
 * cut out of a run of words or read in pairs nothing else tells it from a
 * card. Written digits in one turn keep the digit-only scrubber's rules,
 * which never asked.
 */
function issuedAtLength(digits: string): boolean {
  const n = digits.length;
  if (/^3[47]/.test(digits)) return n === 15;
  if (DINERS_CLUB.test(digits)) return n === DINERS_CLUB_14 || n >= 16;
  if (/^35(?:2[89]|[3-8]\d)/.test(digits)) return n >= 16;
  if (digits.startsWith('4')) return n === 13 || n === 16 || n === 19;
  if (/^(?:5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720|220[0-4])/.test(digits)) return n === 16;
  if (/^[56]/.test(digits)) return n >= 16;
  return false;
}

/**
 * Digit words said with no pause, 13 of them, are a phone number with a zip
 * or a house number run onto it far more often than one of the few 13-digit
 * Visa numbers still about: read as one run of words, a phone and zip passed
 * the Luhn check one time in ten. 14 and 15 are a Diners Club's and an
 * Amex's own lengths (`issuedAtLength`), but a phone number and a house
 * number or a zip as often, and the ranges they start with (30, 36, 38, 39;
 * 34, 37) start area codes too: read that way, up to
 * `MAX_UNBROKEN_SPOKEN_DIGITS_NAMED` they need the card named near them
 * (`cardShaped`), and a Diners Club's 14 is taken only from 36
 * (`UNBROKEN_DINERS_CLUB`).
 */
const MIN_UNBROKEN_SPOKEN_DIGITS = 14;
const MAX_UNBROKEN_SPOKEN_DIGITS_NAMED = 15;

/** 1900–2039: a year said in a list of them ("twenty eighteen", "2006"). */
const YEAR_SHAPED = /^(?:19\d\d|20[0-3]\d)$/;

/**
 * How many of a window's groups of four may read as years. Two or more is a
 * list of years (equipment installed in 2005, 2006, 2007, 2014), which joined
 * in fours passes the Luhn check one time in ten. A real card has two only
 * rarely (about one in 1,700 read in fours), so two are allowed where the
 * card is mentioned near it (`SearchContext.cue`); three or more never.
 */
function maxYearShapedGroups(cardMentioned: boolean): number {
  return cardMentioned ? 2 : 1;
}

/**
 * The window's digits in the groups a card is read in: written digits as
 * written, and spoken groups split into fours where a word ends (a pair that
 * straddles the end of a four makes the window not `aligned`).
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
 * it is written digits inside one turn (those keep exactly the digit-only
 * scrubber's rules). Any window with digit words or pairs in it, cut out of a
 * run of words, or stitched from several turns must start like a payment card
 * (2–6), be a length a card is issued at for its first digits
 * (`issuedAtLength`), and hold no more year-shaped groups of four than a card
 * does (`maxYearShapedGroups`). Digit words said as one unbroken run must be
 * at least `MIN_UNBROKEN_SPOKEN_DIGITS` long, and up to
 * `MAX_UNBROKEN_SPOKEN_DIGITS_NAMED` need the card mentioned near them
 * (`SearchContext.cue`; a phone number and a zip), and at 14 must start 36
 * (`UNBROKEN_DINERS_CLUB`). Words and written digits
 * mixed, or pairs, must be read in a card's groups (`groupedLikeACard`), and
 * a window with pairs in it, or a Diners Club's 14 read as words in other
 * groups, must have the card mentioned near it: a list of times, years,
 * prices or house numbers is said in pairs too.
 *
 * A window stitched from several turns must also take in no turn that is
 * itself a phone number, and fall into its turns the way a card read aloud
 * does (`readLikeACard`). Callers answer an intake flow with bare numbers in
 * a row (a zip, a year, a house number, a callback number), and those joined
 * pass the Luhn check one time in ten; a caller reading a card pauses between
 * its groups instead. Where any turn gives four digits or fewer (a card's
 * group read on its own, or a gate or lockbox code, a last-four, a year or a
 * time answered alone, which nothing in the digits tells apart: a gate code,
 * a serial number read in two fours and a time passed the Luhn check joined
 * as 4-8-4), the card must also be mentioned near it. Two eight-digit halves
 * need no mention: whether a card read so with no card mentioned at all is
 * stitched is the owner's open decision.
 */
function cardShaped(parts: readonly WindowPart[], run: string, ctx: SearchContext): boolean {
  const segs: number[] = [];
  const turnDigits: number[] = [];
  for (const { group, units } of parts) {
    const n = units.reduce((sum, u) => sum + u.digits.length, 0);
    if (segs[segs.length - 1] === group.seg) turnDigits[turnDigits.length - 1] += n;
    else {
      segs.push(group.seg);
      turnDigits.push(n);
    }
  }
  const spoken = parts.some((p) => !p.group.written);
  if (!spoken && segs.length === 1) return true;
  if (!PAYMENT_CARD_FIRST_DIGIT.test(run) || !issuedAtLength(run)) return false;
  if (parts.length === 1 && spoken && run.length < MIN_UNBROKEN_SPOKEN_DIGITS) return false;
  const lastPart = parts[parts.length - 1];
  let cue: boolean | undefined;
  const mentioned = (): boolean =>
    (cue ??= ctx.cue.near(parts[0].units[0].token, lastPart.units[lastPart.units.length - 1].token));
  const { chunks, aligned } = windowChunks(parts);
  let groupedMemo: boolean | undefined;
  const grouped = (): boolean => (groupedMemo ??= groupedLikeACard(parts, chunks, aligned));
  const pairs = parts.some((p) => p.units.some((u) => u.pair));
  const mixed = spoken && parts.some((p) => p.group.written);
  if ((pairs || mixed) && !grouped()) return false;
  // Read in pairs, four house numbers or a run of prices fall into fours
  // just as a card does; only a mention of the card tells them apart.
  if (pairs && !mentioned()) return false;
  // Read as words, 14 or 15 digit words said unbroken (all of one spoken
  // group: a card cut out of a longer one leaves its CVV or expiry, which a
  // phone and zip do not) are a phone number and a house number or a zip as
  // often as a Diners Club or an Amex, and a Diners Club's 14 is read in its
  // own groups (4-6-4, or fours), never in others (3-3-6-2: a reference
  // number). Unbroken, it is taken only from 36: a phone number from 301–305
  // or 380–399 read straight on into four more digits is the same run.
  const unbroken =
    spoken &&
    parts.length === 1 &&
    parts[0].units.length === parts[0].group.units.length &&
    run.length <= MAX_UNBROKEN_SPOKEN_DIGITS_NAMED;
  if ((unbroken || (spoken && run.length === DINERS_CLUB_14 && !grouped())) && !mentioned()) return false;
  if (unbroken && run.length === DINERS_CLUB_14 && !UNBROKEN_DINERS_CLUB.test(run)) return false;
  const years = chunks.filter((c) => YEAR_SHAPED.test(c)).length;
  if (years > 1 && years > maxYearShapedGroups(mentioned())) return false;
  if (segs.length === 1) return true;
  // A turn of four digits or fewer: a card's group read on its own, or a gate
  // or lockbox code, a last-four, a year, a time or a PIN answered alone.
  const shortTurn = turnDigits.some((n) => n <= 4);
  return (
    // Never from the middle of a written number ("(236) 987-2420", then the
    // next turns).
    !parts[0].group.writtenJoin &&
    !segs.some((seg) => ctx.phoneTurns.has(seg)) &&
    readLikeACard(turnDigits, run) &&
    (!shortTurn || mentioned())
  );
}

/**
 * A card cut out of a spoken group is a guess at where the card ends inside
 * words said with no pause, so it takes only the lengths cards are mostly
 * issued in: 16 (Visa, Mastercard, Discover, JCB) or an Amex's 15 (only where
 * it starts like one, `issuedAtLength`), and 19 (Visa, UnionPay) when the cut
 * keeps a code or expiry after the card, as does a Diners Club's 14 read from
 * its first digit (its CVV or expiry run on; a 14-digit cut a stray digit or
 * two into a phone and zip starts like a Diners Club too often) with the card
 * named near it
 * (`cutCardWindows`). Every other length is one more window that can pass the
 * Luhn check by chance in a long run of words that is no card (a reference
 * number, two phone numbers back to back): a 17–19 digit window after one or
 * two stray words is how a 20-digit pair of phone numbers became a "card".
 */
const MIN_CUT_PAN_DIGITS = 14;

function cutLength(digits: number, keepsWhatFollows: boolean, fromGroupStart: boolean): boolean {
  if (digits === MIN_CUT_PAN_DIGITS) return keepsWhatFollows && fromGroupStart;
  return digits === 15 || digits === 16 || (keepsWhatFollows && digits === MAX_PAN_DIGITS);
}

/**
 * At most this many digits of a spoken group may come before a card cut out
 * of it: a stray "oh" or "one" said straight before the card. A longer
 * lead-in is another number, and every start deeper into the run is one more
 * window that can pass the Luhn check by chance.
 */
const MAX_CUT_LEAD_DIGITS = 2;

/** The most a caller says straight after a card: a four-digit code and an MMYY expiry. */
const MAX_DIGITS_AFTER_A_CARD = 8;

/** MMYY with a month 01–12. */
const EXPIRY = /^(?:0[1-9]|1[0-2])\d\d$/;

/** A month, 01–12. */
const MONTH = /^(?:0[1-9]|1[0-2])$/;

/**
 * What a caller says straight after a card with no pause: its security code
 * (three digits, an Amex's four), its expiry (MMYY, or just the month with
 * the year said after a pause, "oh four, twenty seven"), or a code and an
 * expiry in either order. A card cut out of a run of words must leave
 * exactly that after it; any other remainder ("…7936", the rest of a second
 * phone number) means the words were not a card and its CVV.
 */
function followsACard(rest: string, card: string): boolean {
  const code = (s: string): boolean => s.length === 3 || (s.length === 4 && card.length === 15);
  const expiry = (s: string): boolean => EXPIRY.test(s);
  if (code(rest) || expiry(rest) || MONTH.test(rest)) return true;
  return [3, 4].some(
    (k) => (code(rest.slice(0, k)) && expiry(rest.slice(k))) || (expiry(rest.slice(0, 4)) && code(rest.slice(4))),
  );
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
function phoneGroupsAt(groups: readonly string[], i: number): number {
  const len = (k: number): number => groups[i + k]?.length ?? 0;
  const g0 = groups[i];
  if (g0.length === 10 || (g0.length === 11 && g0.startsWith('1'))) return 1;
  if (len(0) === 3 && len(1) === 3 && len(2) === 4) return 3;
  if (g0 === '1' && len(1) === 3 && len(2) === 3 && len(3) === 4) return 4;
  return 0;
}

/**
 * A phone number read with its last digits in pairs ("siete ocho tres,
 * cuatro noventa y ocho, cero cinco, cero nueve"): 3-3-2-2, 3-1-2-2-2, or a
 * Mexican number's five pairs. Searched for only where digit words are read
 * (`cardWindows`); the written path keeps `phoneGroupsAt` as it always had.
 */
const PHONE_SHAPES_IN_PAIRS: ReadonlyArray<readonly number[]> = [
  [3, 3, 2, 2],
  [3, 1, 2, 2, 2],
  [2, 2, 2, 2, 2],
];

function spokenPhoneGroupsAt(groups: readonly string[], i: number): number {
  const phone = phoneGroupsAt(groups, i);
  if (phone > 0) return phone;
  const shape = PHONE_SHAPES_IN_PAIRS.find((lengths) => lengths.every((n, k) => groups[i + k]?.length === n));
  return shape?.length ?? 0;
}

/**
 * How a card read aloud over several turns falls into them, as the digits
 * each turn gives it: whole groups of four in every turn (4-4-4-4, two halves
 * of eight, 4-12), the last turn either whole fours or the final partial
 * group (1–3 digits: a 13-digit card's last digit, a 19-digit card's last
 * three, alone or after its fourth group, "1111 123"); or an Amex in its 4-6-5
 * groups, or a Diners Club International in its 4-6-4 (only a card that
 * starts like one: 34 or 37, and 36). An Amex read in fours ends on a group of
 * three as a 19-digit card does (`endsOnThree`). Intake answers in a row are
 * not read like that: a zip is five digits, a phone ten, a price "$1,250", so
 * a zip in 20000–69999 or a house number starting 2–6 can no longer be
 * stitched into a "card" just because the joined digits pass the Luhn check.
 */
const AMEX_TURN_SPLITS: ReadonlySet<string> = new Set(['4,6,5', '10,5', '4,11']);
const DINERS_TURN_SPLITS: ReadonlySet<string> = new Set(['4,6,4', '10,4', '4,10']);

function readLikeACard(turnDigits: readonly number[], run: string): boolean {
  const split = turnDigits.join(',');
  if (AMEX_TURN_SPLITS.has(split)) return /^3[47]/.test(run);
  if (DINERS_TURN_SPLITS.has(split)) return run.startsWith('36');
  const last = turnDigits[turnDigits.length - 1];
  return (
    turnDigits.slice(0, -1).every((n) => n % 4 === 0) &&
    (last % 4 === 0 || last <= 3 || (endsOnThree(run) && last % 4 === 3))
  );
}

/** Read in fours, a 19-digit card and an Amex end on a group of three. */
function endsOnThree(run: string): boolean {
  return run.length === MAX_PAN_DIGITS || (run.length === 15 && /^3[47]/.test(run));
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
  digits: readonly string[],
  phoneAt: (groups: readonly string[], i: number) => number,
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
function runCards(groups: DigitGroup[], cue: CardCue): CardHit[] {
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
    // Written digits inside one turn were searched in full above (no window
    // of them is cut, and every whole one was tried): only digit words, or
    // turns, can add a card.
    const searchedAbove = rest.every((g) => g.written && g.seg === rest[0].seg);
    if (!searchedAbove && rest.reduce((n, g) => n + g.digits.length, 0) >= MIN_PAN_DIGITS) {
      hits.push(...cardWindows(rest, cue));
    }
    a = b;
  }
  return hits.sort((x, y) => x.from - y.from);
}

/**
 * The card numbers inside a stretch of a run that holds digit words, or
 * spans turns: the leftmost-longest Luhn-valid window of whole groups that
 * keeps `cardShaped`, never starting on a phone number
 * (`spokenPhoneGroupsAt`).
 *
 * Read as words, a card and the CVV, expiry or stray digit word said straight
 * next to it with no pause are one spoken group, so a stretch of the run with
 * no whole-group card is searched again for a card cut out of a spoken group
 * (`cutCardWindows`).
 */
function cardWindows(groups: DigitGroup[], cue: CardCue): CardHit[] {
  const phoneTurns = new Set<number>();
  for (const seg of new Set(groups.map((g) => g.seg))) {
    const own = groups.filter((g) => g.seg === seg).map((g) => g.digits);
    if (spokenPhoneGroupsAt(own, 0) === own.length) phoneTurns.add(seg);
  }
  const ctx: SearchContext = { phoneTurns, cue };
  const whole = (from: number, to: number): WindowPart[] =>
    groups.slice(from, to + 1).map((group) => ({ group, units: group.units }));
  // Built once for the run: the cut search below runs once per card found and
  // reads phone shapes across the whole run, so rebuilding it there made a
  // long run of cards quadratic.
  const digits = groups.map((g) => g.digits);
  const hits: CardHit[] = [];
  // First group of the stretch no whole-group card has covered yet.
  let stretch = 0;
  for (const [first, last] of wholeGroupCards(digits, spokenPhoneGroupsAt, (from, to, run) =>
    cardShaped(whole(from, to), run, ctx),
  )) {
    hits.push(...cutCardWindows(groups, digits, stretch, first, ctx));
    hits.push(groupHit(groups, first, last));
    stretch = last + 1;
  }
  hits.push(...cutCardWindows(groups, digits, stretch, groups.length, ctx));
  return hits;
}

/**
 * The cards in groups `from`..`to` (exclusive) that only a window cutting a
 * spoken group between two of its words finds: the whole-group search found
 * none there. One end of such a window is a group boundary and the other is
 * inside a spoken group, so it takes the card and leaves the CVV or expiry
 * run on after it ("four oh one two … one eight eight one oh four two seven"),
 * or a stray digit word before it ("number one four oh one two …"). Such a
 * window must be a length cards are cut at (`cutLength`), start at most
 * `MAX_CUT_LEAD_DIGITS` into its group, leave after it exactly what follows a
 * card (`followsACard`), pass the Luhn check and keep `cardShaped`; a Diners
 * Club's 14 also needs the card named near it (`SearchContext.cue`). Written
 * digits are one token per group, so the written path never gets here with
 * anything to cut.
 */
function cutCardWindows(
  groups: DigitGroup[],
  digits: readonly string[],
  from: number,
  to: number,
  ctx: SearchContext,
): CardHit[] {
  const units: Array<DigitUnit & { group: number; lead: number; first: boolean; last: boolean }> = [];
  for (let g = from; g < to; g++) {
    let lead = 0;
    groups[g].units.forEach((u, k, all) => {
      units.push({ ...u, group: g, lead, first: k === 0, last: k === all.length - 1 });
      lead += u.digits.length;
    });
  }
  const hits: CardHit[] = [];
  let p = 0;
  while (p < units.length) {
    const start = units[p];
    if (start.first) {
      const phone = spokenPhoneGroupsAt(digits, start.group);
      if (phone > 0) {
        // Kept verbatim, as in the whole-group search; scanning resumes after
        // it (forward from here: a run of phone numbers is one pass).
        while (p < units.length && units[p].group < start.group + phone) p++;
        continue;
      }
    } else if (start.lead > MAX_CUT_LEAD_DIGITS) {
      p++;
      continue;
    }
    const windows: Array<{ end: number; digits: string }> = [];
    let run = '';
    for (let q = p; q < units.length; q++) {
      run += units[q].digits;
      if (run.length > MAX_PAN_DIGITS) break;
      if (run.length >= MIN_CUT_PAN_DIGITS) windows.push({ end: q, digits: run });
    }
    const hit = windows.reverse().find((w) => {
      const end = units[w.end];
      // Exactly one end on a group boundary: both is a whole-group window
      // (already searched), neither is a stretch out of the middle of a run.
      if (start.first === end.last) return false;
      if (!cutLength(w.digits.length, !end.last, start.first)) return false;
      // What the caller said after the card in the same group: its digits
      // past this unit (at most a code and an expiry, so a long rest is none).
      if (!end.last) {
        const group = groups[end.group].digits;
        const restFrom = end.lead + end.digits.length;
        if (group.length - restFrom > MAX_DIGITS_AFTER_A_CARD) return false;
        if (!followsACard(group.slice(restFrom), w.digits)) return false;
      }
      if (!isLuhnValid(w.digits)) return false;
      // A 17- or 18-digit order, serial or confirmation number read as words
      // and starting like a Diners Club reads as its 14 and a CVV or an expiry
      // one time in ten: only a mention of the card near it tells them apart.
      if (w.digits.length === MIN_CUT_PAN_DIGITS && !ctx.cue.near(start.token, end.token)) return false;
      const parts: WindowPart[] = [];
      for (const u of units.slice(p, w.end + 1)) {
        const part = parts.at(-1);
        if (part?.group === groups[u.group]) (part.units as DigitUnit[]).push(u);
        else parts.push({ group: groups[u.group], units: [u] });
      }
      return cardShaped(parts, w.digits, ctx);
    });
    if (hit) {
      hits.push({ from: start.token, to: units[hit.end].token });
      p = hit.end + 1;
    } else {
      p++;
    }
  }
  return hits;
}

/**
 * Every card number in a token stream. A run is digit tokens joined by
 * group separators (`joinsGroups`); digit words separated only by spaces form
 * one spoken group, and anything else (a comma, a filler, a switch between
 * words and written digits) starts the next group.
 */
function findCardHits(tokens: Token[], cue: CardCue): CardHit[] {
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
        seg: first.seg,
        units: [{ digits: first.digits, token: i, pair: first.pair === true }],
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
      const unit = { digits: right.digits, token: next, pair: right.pair === true };
      if (sameSpokenGroup) {
        group.digits += right.digits;
        group.units.push(unit);
      } else {
        const written = right.kind === 'num';
        groups.push({
          digits: right.digits,
          seg: right.seg,
          units: [unit],
          written,
          writtenJoin: written && tokens[last].kind === 'num' && !joiner.some((t) => t.kind === 'turn'),
        });
      }
      last = next;
    }
    const total = groups.reduce((n, g) => n + g.digits.length, 0);
    if (total >= MIN_PAN_DIGITS) hits.push(...runCards(groups, cue));
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
  let out = '';
  let pos = 0;
  for (const region of candidateRegions(tagged)) {
    const stretch = tagged.slice(region.start, region.end);
    const tokens = tokenize(stretch);
    for (const hit of findCardHits(tokens, textCue(stretch, tokens, placeholder))) {
      const start = region.start + tokens[hit.from].start;
      const end = region.start + tokens[hit.to].end;
      onRedact?.(tagged.slice(start, end), start);
      out += tagged.slice(pos, start) + placeholder;
      pos = end;
    }
  }
  return pos === 0 ? tagged : out + tagged.slice(pos);
}

/**
 * What a cross-turn search may read around the caller's turns without ever
 * stitching or rewriting it, for a mention of the card (`CARD_CUE`, never of
 * paying: the agent talks about payment links while it takes gate codes and
 * years, and callers about paying later).
 */
export interface CardSplitContext {
  /**
   * What the agent said around the turns, by the caller turn it came before:
   * `agentLines[k]` holds its lines between caller turns k−1 and k (for turn
   * 0, its last line before it; {@link agentLinesBefore}). A card read over
   * turns a..b reads `agentLines[a..b]`: the line just before it and those
   * between its turns.
   */
  agentLines?: ReadonlyArray<readonly string[]>;
  /**
   * The caller's own turn just before the first of `turns` (inside the
   * window's minute), when the window is full: "my card number is", then a
   * 19-digit card read group by group over the five turns.
   */
  callerTurnBefore?: string;
}

/**
 * Most turns of nothing but a pause ("okay", "um", "sí"; `PAUSE_TURN`) a
 * caller may say between naming the card and reading it: "my card number
 * is", "okay", then the groups; or the agent's "go ahead with the card
 * number" answered with "okay". More is another moment of the call.
 */
const MAX_PAUSE_TURNS_BEFORE_CARD = 2;

/**
 * What the agent asks for when it asks for another number than the card: an
 * address, a house, unit or street number, a phone or callback number (or a
 * number to call or text, the number the caller is calling from, which
 * number the tech should use, the best number for the caller, "¿a qué número
 * le podemos llamar?"), a code (gate, lockbox, alarm, zip, confirmation), a
 * PIN, a year, a model, serial, order, account, customer, policy, meter,
 * claim, tracking, permit, license or ID number, a member number ("member
 * no.") or ID, a VIN, a social, a birthday, a date or a time ("¿Código
 * postal?", "¿Y la caja de llaves?"), each in the plural too ("What times
 * work for you?",
 * "¿Cuáles son los códigos de acceso?"). The turns answer it (`turnsCue`).
 * "Go ahead, what's the number?" names none of these, nor does "call out the
 * number": they ask for the card again. Nor do "times" counting how often
 * ("it cut out a few times", "read it two times"; only "what" or "which
 * times" asks for one), "series" ("the series of numbers on the front"), or
 * a member who is no member number ("Members get ten percent off", "a family
 * member's name").
 */
const ASKS_FOR_OTHER_NUMBER =
  /(?<![\p{L}\p{M}])(?:code|zip|postal|address|street|phone|cell|mobile|callback|call(?!\s+(?:it\s+|them\s+)?out)|calling\s+from|text|(?:good|best)\s+number|number\s+for\s+you|which\s+number\s+(?:should|shall|would|will|do|does|can|could)|reach|contact|house|unit|apartment|apt|suite|lockbox|gate|alarm|pin|year|model|serial|order|account|customer|confirmation|reference|extension|policy|meter|invoice|ticket|date|time(?!s)|(?:what|which)\s+time|birth(?:day)?|claim|tracking|permit|licen[cs]e|social|vin|member\s+(?:number|#|id|no\.?)|id|c[oó]digo|direcci[oó]n|calle|tel[eé]fono|celular|llamar(?:le|lo|la|les)?|marcar|mejor\s+n[uú]mero|contacto|casa|unidad|apartamento|port[oó]n|caja|alarma|año|modelo|serie(?!s)|orden|cuenta|cliente|confirmaci[oó]n|referencia|extensi[oó]n|p[oó]liza|medidor|factura|fecha|hora|reclamo)(?:e?s)?(?![\p{L}\p{M}])/iu;

/**
 * What names a card's own data, or no number at all, though it holds a word
 * `ASKS_FOR_OTHER_NUMBER` lists: the expiration date (the exp. date, la fecha
 * de caducidad), the security code (the three-digit code, the code on the
 * back, el código de tres dígitos), the billing zip (el código postal de
 * facturación), each in the plural too ("the expiration dates", "los
 * códigos de seguridad"), "take your time", "four digits at a time", "one
 * more time". A re-ask for the card says them ("Could you read me the
 * number and the expiration date?"). "The alarm's security code" still
 * names the alarm.
 */
const NAMES_NO_OTHER_NUMBER =
  /(?<![\p{L}\p{M}])(?:(?:(?:expiration|expiry)(?:\s+date)?|exp\.?\s+date|security\s+code|(?:three|3)[\s-]+digit\s+code|billing\s+(?:zip|postal)(?:\s+code)?)(?:e?s)?|date\s+it\s+expires|codes?\s+on\s+the\s+back|(?:las?\s+)?fechas?\s+de\s+(?:vencimiento|expiraci[oó]n|caducidad)|c[oó]digos?\s+de\s+(?:seguridad|atr[aá]s|(?:tres|3)\s+d[ií]gitos)|c[oó]digos?\s+postal(?:es)?\s+de\s+facturaci[oó]n|take\s+your\s+time|(?:at\s+a|one\s+more)\s+time|t[oó]mese\s+su\s+tiempo)(?![\p{L}\p{M}])/giu;

/** A sentence that asks ("?", "¿") or requests ("go ahead with", "please", "dígame", "por favor"). */
const ASKS_OR_REQUESTS =
  /[?¿]|(?<![\p{L}\p{M}])(?:go\s+ahead\s+with|give\s+me|read\s+me|tell\s+me|i['’]?ll\s+need|i\s+need|can\s+i\s+(?:get|have)|please|d[ií]game|d[eé]me|l[eé]ame|necesito|por\s+favor)(?![\p{L}\p{M}])/iu;

/**
 * Where what the agent has the caller fetch ends: where the agent says what
 * it does itself ("I'll pull up", "I will open", "we pull up", "let me
 * open"), as a comma often marks. One space of the run before it, so a
 * clause read a character at a time never rescans a long run of spaces.
 */
const AGENT_GOES_ON = String.raw`\s(?:i|we|let\s+me)(?![\p{L}\p{M}])`;

/**
 * The caller asked to fetch a number or have it ready, and what it is: the
 * clause after "while you", "mientras busca" or "tenga a mano" (up to a
 * comma, a semicolon, a colon, an ellipsis, a dash or a bracket, "—", "–",
 * "(" or ")", or `AGENT_GOES_ON`), what
 * "we'll need", "we will need" or "I will need" needs (that clause up to a
 * "to" after what it names, "we'll need that to pay off the invoice",
 * unless it is to call, text, reach or contact the caller, "we'll need
 * your number to call you back"; "we'll need to get" or "need you to grab"
 * what follows), or what "have your … ready" or "handy" holds. A hold says
 * it as often as an ask does, once its "please" is set aside (`HOLDS_ON`):
 * "Please hold on while you grab your account number.", "Please note we'll
 * need your gate code.", "Espere, por favor, y tenga a mano el código del
 * portón.". It asks for what it fetches and no more: in "While you grab
 * that, I'll pull up your invoice.", "While you grab that—I'll pull up
 * your invoice.", "While you grab the number I'll pull up the invoice.",
 * "We'll need that—then the invoice is paid." or "I will need the number
 * to close out the invoice." the invoice is the agent's own.
 */
const FETCHES = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:while\s+you|mientras\s+busca|tenga\s+a\s+mano)(?![\p{L}\p{M}])((?:(?!${AGENT_GOES_ON})[^,;:…—–()])*)` +
    String.raw`|(?<![\p{L}\p{M}])(?:we['’]?ll|we\s+will|i\s+will)\s+need(?![\p{L}\p{M}])` +
    String.raw`((?:\s+you)?(?:\s+to(?=\s))?(?:(?!\sto\s|${AGENT_GOES_ON})[^,;:…—–()])*(?:\s+to\s+(?:call|text|reach|contact)\s+you)?)` +
    String.raw`|(?<![\p{L}\p{M}])have\s+your([^.!?]{0,40})(?:ready|handy)(?![\p{L}\p{M}])`,
  'giu',
);

/** A period that never ends a sentence: after an honorific ("Mr. Smith", "Sra. García") or "exp." ("the exp. date"). */
const NEVER_ENDS_SENTENCE = String.raw`(?:^|[\s(])(?:[Mm]rs?|[Mm]s|[Ss]ra?|[Ss]rta|[Ee]xp)`;

/**
 * A period that ends an abbreviation, which may end its sentence or not
 * ("Main St." or "St. Petersburg", "at 2 p.m." or "the 2 p.m. visit",
 * "Dr.", "Jr.", "apt.", "No.", "etc.", "e.g.", "N." or another single
 * letter), or an ellipsis ("..."; `SENTENCE_ENDS` reads "…" the same way,
 * but for a "..." run straight on into the next word).
 */
const MAY_END_SENTENCE = String.raw`(?:^|[\s(])(?:[Dd]r|[Ss]t|[Jj]r|[Aa]pt|[Ss]te|[Nn]o|\p{L}|[AaPp]\.[Mm]|e\.g|i\.e|etc|vs)|\.\.`;

/**
 * Where a sentence of the agent's ends, read three ways: after a "!" or a
 * "?", or a period that ends no honorific (`NEVER_ENDS_SENTENCE`), once
 * with every abbreviation and ellipsis taken as its end, once with every
 * abbreviation and ellipsis but a "..." run straight on into the next word,
 * and once with none (`MAY_END_SENTENCE`). Split at every period, "What's
 * the gate code, Mr. Smith?" and "the 2 p.m. visit?" were two "sentences",
 * neither an ask for another number; split at none, "We take Visa,
 * Mastercard, Amex, etc. What's the gate code?" was one, which names the
 * card. An ellipsis ("..." or "…", with or without a space after it) is an
 * end the first way and none the third; the second way, "…" is and "..."
 * is only before a space. Never an end, "We take all major cards at the
 * visit… what's the gate code?" (or "visit...what's") was one sentence that
 * named the card; always one, "Sure, you can pay by card... Go ahead
 * with...the gate code." (or "Amex, etc. Go ahead with...") left the
 * request in two halves, "Go ahead with" and "the gate code.", neither of
 * them an ask.
 */
const SENTENCE_ENDS: readonly RegExp[] = [
  new RegExp(String.raw`(?<=[!?]|(?<!${NEVER_ENDS_SENTENCE})\.)\s+|(?<=…|\.\.\.)\s*`, 'u'),
  new RegExp(String.raw`(?<=[!?]|(?<!${NEVER_ENDS_SENTENCE})\.)\s+|(?<=…)\s*`, 'u'),
  new RegExp(String.raw`(?<=[!?]|(?<!${NEVER_ENDS_SENTENCE}|${MAY_END_SENTENCE})\.)\s+`, 'u'),
];

/**
 * What a "second" the agent asks for is when a number, a code or a way to
 * reach the caller follows it, after a comma too: "give me a second phone
 * number", "give me a second gate code", "give me a second, alternate
 * phone number", "give me a second way to reach you", "deme un segundo
 * número de teléfono", "deme un segundo código" ask for one, and are no
 * hold (`HOLDS_ON`).
 */
const NO_NUMBER_AFTER = String.raw`(?!,?\s+(?:[\p{L}\p{M}]+\s+)?(?:numbers?|phones?|cell|mobile|contact|callback|address|email|line|codes?|way|form|n[uú]meros?|tel[eé]fonos?|celular|contacto|correo|direcci[oó]n|c[oó]digos?|forma|manera)(?![\p{L}\p{M}]))`;

/**
 * A pause the agent takes, no request, though it says "please" or "por
 * favor": "please hold", "please hang on", "please be patient", "please
 * bear with me", "please note", "one moment, please", "(please) give me" or
 * "allow me a moment" or "a second", "un momento, por favor", "(por favor,)
 * deme un momento", "espere, por favor". With it, "Please hold while I pull
 * up your account." read as a request for an account number. What the
 * caller is asked to fetch with it ("Please hold on while you grab your
 * account number.") is still asked for (`FETCHES`).
 */
const HOLDS_ON = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?:please\s+(?:hold|wait|bear\s+with|note|stand\s+by|stay\s+on|hang\s+on|be\s+patient)` +
    String.raw`|(?:please\s+)?(?:give|allow)\s+me\s+(?:a|one|just\s+a)\s+(?:moment|second|sec|minute)${NO_NUMBER_AFTER}(?:,?\s+please)?` +
    String.raw`|(?:por\s+favor,?\s+)?d[eé]me\s+un\s+(?:momento|segundo)${NO_NUMBER_AFTER}(?:,?\s+por\s+favor)?` +
    String.raw`|(?:hold\s+on|bear\s+with\s+me),?\s+please|(?:one|a|just\s+a)\s+(?:moment|second|sec|minute),?\s+please` +
    String.raw`|un\s+(?:momento|segundo),?\s+por\s+favor|espere,?\s+por\s+favor|por\s+favor,?\s+espere)(?![\p{L}\p{M}])`,
  'giu',
);

/**
 * An agent line with a sentence that asks or requests (`ASKS_OR_REQUESTS`,
 * a hold it puts the caller on aside, `HOLDS_ON`) another number than the
 * card (`ASKS_FOR_OTHER_NUMBER`, its card data and idioms aside,
 * `NAMES_NO_OTHER_NUMBER`), or has the caller fetch one (`FETCHES`: the
 * number in what it fetches, not one the agent pulls up itself), and names
 * no card. Read sentence by sentence,
 * where a sentence ends read three ways (`SENTENCE_ENDS`): "Thanks, I have
 * your address on file. What's the number?" asks for the card, and so does
 * "Can I get the card number and the zip code?"; "We'll call you when the
 * tech is on the way" and "Please hold while I pull up your account." ask
 * for nothing.
 */
function asksForAnotherNumber(line: string, placeholder: string): boolean {
  const namesAnother = (text: string): boolean => ASKS_FOR_OTHER_NUMBER.test(text.replace(NAMES_NO_OTHER_NUMBER, ' '));
  return SENTENCE_ENDS.some((end) =>
    line.split(end).some(
      (sentence) =>
        ((ASKS_OR_REQUESTS.test(sentence.replace(HOLDS_ON, ' ')) && namesAnother(sentence)) ||
          [...sentence.matchAll(FETCHES)].some((fetch) => namesAnother(fetch[1] ?? fetch[2] ?? fetch[3] ?? ''))) &&
        !mentionsCard(sentence, placeholder),
    ),
  );
}

/**
 * A mention of the card near a window read across turns (a..b): in one of the
 * turns it spans within `MAX_CUE_DISTANCE_WORDS` words of the digits that
 * turn gives it (each turn read as one text, `textCue`: a window wholly
 * inside one turn reads exactly as `redactCardNumbers` reads that turn), in
 * the caller's turn just before them (a−1, or `callerTurnBefore` for the
 * first) as near its end (counting the words the window's first turn says
 * before its digits), in the agent's lines just before and between them, or
 * a turn of it that reads on from the one before ("the next four are",
 * `READS_ON`). Up to `MAX_PAUSE_TURNS_BEFORE_CARD` pause turns just before
 * the window (`pauseTurns`) are read past (their words counted, and the
 * agent's lines before each read too): the caller's turn before is the one
 * before them. Not when the agent asks for another number
 * (`asksForAnotherNumber`: "What's the house number?", "Go ahead with the
 * gate code.", "What number should the tech call?") right before the window
 * or before any pause read past, even in a line that also talks of cards:
 * the turns answer it, and card talk before the pause names no card of
 * theirs (read past it, a caller's bare answers were stitched into a
 * "card"). A mention further back, or far from the digits in a long turn, is
 * another moment of the call: the caller asked about paying by card, then
 * gave gate codes or read out the times the technician gave them.
 */
function turnsCue(
  tokens: readonly Token[],
  turns: readonly string[],
  readsOn: ReadonlySet<number>,
  pauseTurns: ReadonlySet<number>,
  placeholder: string,
  context: CardSplitContext,
): CardCue {
  // Where each turn's tokens start in `tokens` (they are in turn order).
  const segStart: number[] = [];
  tokens.forEach((t, i) => {
    segStart[t.seg] ??= i;
  });
  const segEnd = (seg: number): number => segStart[seg + 1] ?? tokens.length;
  const read = new Map<number, TextMentions | undefined>();
  const turnMentions = (seg: number): TextMentions | undefined => {
    if (!read.has(seg)) {
      if (seg >= 0) {
        read.set(seg, textCue(turns[seg], tokens.slice(segStart[seg], segEnd(seg)), placeholder));
      } else {
        const text = context.callerTurnBefore;
        read.set(seg, text === undefined ? undefined : textCue(text, tokenize(text), placeholder));
      }
    }
    return read.get(seg);
  };
  const agentMentions = (seg: number): boolean =>
    (context.agentLines?.[seg] ?? []).some((line) => mentionsCard(line, placeholder));
  const agentAsksAnother = (seg: number): boolean =>
    (context.agentLines?.[seg] ?? []).some((line) => asksForAnotherNumber(line, placeholder));
  return {
    near(from, to) {
      const a = tokens[from].seg;
      const b = tokens[to].seg;
      for (let seg = a; seg <= b; seg++) {
        // The tokens of the window in this turn, as offsets into it.
        const lo = seg === a ? from : segStart[seg];
        const hi = seg === b ? to : segEnd(seg) - 1;
        if (turnMentions(seg)!.near(lo - segStart[seg], hi - segStart[seg])) return true;
        if (agentMentions(seg)) return true;
        if (seg > a && readsOn.has(seg)) return true;
      }
      let before = a - 1;
      let pauseWords = 0;
      if (!agentAsksAnother(a)) {
        for (let k = 0; k < MAX_PAUSE_TURNS_BEFORE_CARD && before >= 0 && pauseTurns.has(before); k++, before--) {
          // The pause answers the agent's ask before it ("What's the gate
          // code?" "Yep."), even in the line that talks of cards.
          if (agentAsksAnother(before)) return false;
          if (agentMentions(before)) return true;
          pauseWords += turnMentions(before)!.wordsBefore(segEnd(before) - segStart[before]);
        }
      }
      const tail = turnMentions(before)?.wordsAfterLastMention();
      return (
        tail !== undefined && tail + pauseWords + turnMentions(a)!.wordsBefore(from - segStart[a]) <= MAX_CUE_DISTANCE_WORDS
      );
    },
  };
}

/**
 * A card number a caller split across turns: pausing mid-number leaves
 * several turns that each hold fewer than 13 digits, so the per-turn scrub
 * finds nothing. `turns` are one session's CALLER turns in the order they
 * were said (never agent turns); they are read as one stream with a pause
 * (a group boundary) between turns, and every Luhn-valid card found has the
 * span each turn contributed to it replaced with the marker, so a card split
 * over three turns leaves the marker in all three. A card stitched from
 * several turns must also look like one read aloud: it starts with 2–6, no
 * turn is a phone number, it falls into its turns in a card's groups
 * (`readLikeACard`), it is a length a card is issued at (`issuedAtLength`),
 * it holds at most one year-shaped group, and where any turn gives four
 * digits or fewer the card is mentioned near it: in its turns near their
 * digits or at the end of the caller's turn just before them, by the agent
 * right before or between them (`context`), or by a turn that reads on ("the
 * next four are …", `READS_ON`; see `turnsCue`). Bare intake answers in a
 * row are left alone.
 * A card wholly inside one turn, and Deepgram's card tag, are replaced too,
 * so a stored row written before the scrubber comes out clean.
 *
 * Returns the turns rewritten (same length and order), or null when nothing
 * changed. `onRedact` (optional) sees each replaced span with the index of
 * the turn it is in. The caller bounds the window ({@link cardSplitWindow}:
 * the live path in `VoiceSessionStore`, the recording boundary through
 * {@link redactCardNumbersInCallTurns}).
 */
export function redactCardNumbersAcrossTurns(
  turns: readonly string[],
  placeholder: string = CARD_NUMBER_PLACEHOLDER,
  context: CardSplitContext = {},
  onRedact?: (turn: number, matched: string) => void,
): string[] | null {
  const tagged = turns.map((text) => text.replace(DEEPGRAM_CARD_TAG, placeholder));
  const tokens: Token[] = [];
  const readsOn = new Set<number>();
  const pauseTurns = new Set<number>();
  for (const [seg, text] of tagged.entries()) {
    // A turn of nothing but a pause ("okay", "um"), the first too, is read
    // past for a mention of the card before it (`turnsCue`).
    if (PAUSE_TURN.test(text)) pauseTurns.add(seg);
    if (seg === 0) {
      tokens.push(...tokenize(text, seg));
      continue;
    }
    tokens.push({ kind: 'turn', seg, start: 0, end: 0, digits: '' });
    // What the turn opens with before reading on is one joiner token.
    const leadIn = CONTINUATION_LEAD_IN.exec(text);
    const lead = leadIn?.[0] ?? '';
    const turnTokens = tokenize(text, seg);
    if (!/\p{L}/u.test(lead)) {
      tokens.push(...turnTokens);
      continue;
    }
    if (leadIn?.[1] !== undefined && READS_ON.test(leadIn[1])) readsOn.add(seg);
    tokens.push({ kind: 'lead', seg, start: 0, end: lead.length, digits: '' });
    tokens.push(...turnTokens.filter((t) => t.start >= lead.length));
  }
  // Per turn, the spans to replace: for each card, from the first to the last
  // of its digit tokens that sit in that turn.
  const spans: Array<Array<{ start: number; end: number }>> = tagged.map(() => []);
  for (const hit of findCardHits(tokens, turnsCue(tokens, tagged, readsOn, pauseTurns, placeholder, context))) {
    const inHit = new Map<number, { start: number; end: number }>();
    for (let k = hit.from; k <= hit.to; k++) {
      const t = tokens[k];
      if (!isDigitToken(t)) continue;
      const span = inHit.get(t.seg);
      if (span) span.end = t.end;
      else inHit.set(t.seg, { start: t.start, end: t.end });
    }
    for (const [seg, span] of inHit) spans[seg].push(span);
  }
  const rewritten = tagged.map((text, seg) => {
    let out = '';
    let pos = 0;
    for (const { start, end } of spans[seg]) {
      onRedact?.(seg, text.slice(start, end));
      out += text.slice(pos, start) + placeholder;
      pos = end;
    }
    return out + text.slice(pos);
  });
  return rewritten.some((text, i) => text !== turns[i]) ? rewritten : null;
}

/**
 * The window a card split across caller turns is read in: each caller turn
 * together with the caller turns just before it, up to
 * {@link CARD_SPLIT_WINDOW_TURNS} in all, said within
 * {@link CARD_SPLIT_WINDOW_MS} of it. Agent turns never join.
 *
 * Why five turns and a minute: the longest card (19 digits) read in its
 * natural groups (4-4-4-4-3) is five utterances, a 16-digit card with a pause
 * after every group four, an Amex three; a caller reading a card group by
 * group, the agent saying "go on" in between, is done well inside a minute.
 * Digits further apart are other numbers said at other points of the call (a
 * callback number early, a zip later), and stitching them in would only add
 * false Luhn hits. The bound also keeps the work per turn constant.
 */
const CARD_SPLIT_WINDOW_TURNS = 5;
const CARD_SPLIT_WINDOW_MS = 60_000;

/**
 * The earlier caller turns (oldest first) a caller turn said at `at` is read
 * together with, and the caller turn said just before them inside the minute
 * (read only for a mention of the card: {@link CardSplitContext}). Keep both
 * to slide the window on.
 */
export function cardSplitWindow<T extends { at: number }>(
  earlier: readonly T[],
  at: number,
): { window: T[]; before: T | undefined } {
  const recent = earlier.filter((t) => at - t.at <= CARD_SPLIT_WINDOW_MS);
  const window = recent.slice(-(CARD_SPLIT_WINDOW_TURNS - 1));
  return { window, before: recent[recent.length - window.length - 1] };
}

/** One line of a call leg, in the order it was said. */
interface CallLine {
  speaker: 'caller' | 'agent';
  text: string;
}

/**
 * What the agent said right before each caller turn of a window
 * ({@link CardSplitContext.agentLines}): for the caller turn at each of
 * `callerIndexes` (indexes into `lines`; one past the end for a turn not in
 * `lines` yet), the agent lines since the caller's previous line.
 */
export function agentLinesBefore(lines: readonly CallLine[], callerIndexes: readonly number[]): string[][] {
  return callerIndexes.map((index) => {
    const said: string[] = [];
    for (let i = Math.min(index, lines.length) - 1; i >= 0 && lines[i].speaker === 'agent'; i--) {
      said.unshift(lines[i].text);
    }
    return said;
  });
}

/**
 * A whole leg's turns (oldest first, both speakers, with the epoch ms each
 * was said), its caller turns read again exactly as the live path read them
 * as they were said: each caller turn in its {@link cardSplitWindow}, with the
 * earlier turns' text as already rewritten, the caller's turn before the
 * window and the agent's lines around them ({@link agentLinesBefore}). The
 * recording boundary runs this over the stored rows, so a card whose live
 * rewrite of those rows failed (or had not landed yet) still leaves them
 * before ingestion. An agent turn never joins a window; one said between the
 * card's turns is rewritten where it repeats a part of the card the caller had
 * already said ({@link redactCardFragments}: the confirm readback). Returns
 * the turns rewritten (same length and order), or null when nothing changed.
 */
export function redactCardNumbersInCallTurns(turns: ReadonlyArray<CallLine & { at: number }>): string[] | null {
  const texts = turns.map((t) => t.text);
  let recent: Array<{ k: number; at: number }> = [];
  let changed = false;
  turns.forEach(({ speaker, text, at }, k) => {
    if (speaker !== 'caller') return;
    const { window: earlier, before } = cardSplitWindow(recent, at);
    const kept = before ? [before] : [];
    // An empty utterance holds no digits and never joins the window.
    if (text.trim().length === 0) {
      recent = [...kept, ...earlier];
      return;
    }
    const window = [...earlier, { k, at }];
    recent = [...kept, ...window];
    if (earlier.length === 0) return;
    const fragments = new Map<number, string[]>();
    const rewritten = redactCardNumbersAcrossTurns(
      window.map((t) => texts[t.k]),
      CARD_NUMBER_PLACEHOLDER,
      {
        agentLines: agentLinesBefore(
          turns,
          window.map((t) => t.k),
        ),
        ...(before ? { callerTurnBefore: texts[before.k] } : {}),
      },
      (j, matched) => fragments.set(window[j].k, [...(fragments.get(window[j].k) ?? []), matched]),
    );
    if (!rewritten) return;
    rewritten.forEach((next, j) => {
      if (next === texts[window[j].k]) return;
      texts[window[j].k] = next;
      changed = true;
    });
    // The agent's lines between the card's turns, each against the parts the
    // caller had said before it.
    for (let a = window[0].k + 1; a < k; a++) {
      if (turns[a].speaker !== 'agent') continue;
      const said = [...fragments].filter(([callerK]) => callerK < a).flatMap(([, f]) => f);
      const next = redactCardFragments(texts[a], said);
      if (next === texts[a]) continue;
      texts[a] = next;
      changed = true;
    }
  });
  return changed ? texts : null;
}

/** The digits `said` reads, written or as words ("4111 1111", "four one one one" → "41111111"). */
function digitsRead(said: string): string {
  return tokenize(said)
    .filter(isDigitToken)
    .map((t) => t.digits)
    .join('');
}

/**
 * PRIV-3 — `text` with every number in it that reads the same digits as one
 * of `fragments`, or as several of them said one after the other, replaced
 * by the marker. `fragments` are the spans of the caller's earlier turns a
 * cross-turn card rewrite replaced, in the order they were said. What those
 * turns handed on before a later turn showed they held part of a card
 * repeats them, often in another form: the agent's confirm readback renders
 * what the classifier took from the turn ("the card on file is
 * 4111-1111-1111"), and so do the FSM context's entities.
 *
 * Read as the card search reads a run (`findCardHits`: written groups,
 * digit words, their joiners), only whole groups are matched: a ZIP that
 * merely holds the same digits ("84111") is another number, and so is a
 * phone number ending in them ("602 555 4111", `spokenPhoneGroupsAt`). A
 * number word next to the digits is its own group ("the last four, 1111").
 */
export function redactCardFragments(
  text: string,
  fragments: readonly string[],
  placeholder: string = CARD_NUMBER_PLACEHOLDER,
): string {
  const read = fragments.map(digitsRead).filter((d) => d.length > 0);
  const wanted = new Set<string>();
  for (let a = 0; a < read.length; a++) {
    let joined = '';
    for (let b = a; b < read.length; b++) wanted.add((joined += read[b]));
  }
  if (wanted.size === 0 || !text) return text;
  const longest = Math.max(...[...wanted].map((d) => d.length));
  const tokens = tokenize(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isDigitToken(tokens[i])) continue;
    // The run's groups: a written number, or digit words said with no pause.
    const groups: Array<{ digits: string; first: number; last: number }> = [
      { digits: tokens[i].digits, first: i, last: i },
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
      if (tokens[last].kind === 'spoken' && right.kind === 'spoken' && joiner.every((t) => t.kind === 'space')) {
        group.digits += right.digits;
        group.last = next;
      } else {
        groups.push({ digits: right.digits, first: next, last: next });
      }
      last = next;
    }
    const digits = groups.map((g) => g.digits);
    // "(602) 555-4111": the area code in parentheses is no part of the run.
    let back = i - 1;
    while (back >= 0 && tokens[back].kind === 'space') back--;
    const areaCode =
      text[tokens[back]?.start] === ')' && tokens[back - 1]?.kind === 'num' && text[tokens[back - 2]?.start] === '('
        ? tokens[back - 1].digits
        : undefined;
    let a = areaCode !== undefined && phoneGroupsAt([areaCode, ...digits], 0) === 3 ? 2 : 0;
    while (a < groups.length) {
      const phone = spokenPhoneGroupsAt(digits, a);
      if (phone > 0) {
        a += phone;
        continue;
      }
      let joined = '';
      let hit = -1;
      for (let b = a; b < groups.length && (joined += digits[b]).length <= longest; b++) {
        if (wanted.has(joined)) hit = b;
      }
      if (hit < 0) {
        a++;
        continue;
      }
      spans.push({ start: tokens[groups[a].first].start, end: tokens[groups[hit].last].end });
      a = hit + 1;
    }
    i = last;
  }
  let out = '';
  let pos = 0;
  for (const { start, end } of spans) {
    out += text.slice(pos, start) + placeholder;
    pos = end;
  }
  return spans.length === 0 ? text : out + text.slice(pos);
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
