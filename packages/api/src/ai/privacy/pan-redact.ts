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
 * (`cardShaped`): it starts like a payment card (2–6), holds no more
 * year-shaped groups than a card does, is read in a card's groups where it
 * mixes words and digits or holds pairs, and, holding pairs (which lists of
 * times, years, prices and house numbers do too), has the card mentioned in
 * the same text.
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
 * Words that say a card is what is being read out ("my card is", "the Visa",
 * "mi tarjeta"). Bare groups of four said one per turn read exactly like gate
 * codes, last-four answers or years given one after another, so a card
 * stitched from such turns must be mentioned in them or by the agent around
 * them (`redactCardNumbersAcrossTurns`).
 */
const CARD_WORDS = String.raw`cards?|visa|master\s?card|amex|american\s+express|discover|credit|debit|cvv|cvc|tarjetas?|cr[ée]dito|d[ée]bito`;
/**
 * A caller saying they want to pay ("can I pay now", "quiero pagar") is about
 * to read a card too. The agent is not: it talks about payment links and
 * payment due at the visit while it collects gate codes and years.
 */
const PAYMENT_WORDS = String.raw`pay|paying|payment|pago|pagar`;
const CARD_CUE = new RegExp(String.raw`(?<![\p{L}\p{M}])(?:${CARD_WORDS})(?![\p{L}\p{M}])`, 'iu');
const CALLER_CARD_CUE = new RegExp(String.raw`(?<![\p{L}\p{M}])(?:${CARD_WORDS}|${PAYMENT_WORDS})(?![\p{L}\p{M}])`, 'iu');

/**
 * True when the caller's `text` mentions a card or paying (`agent`: when the
 * agent's text mentions a card). The marker of a card already scrubbed does
 * not count.
 */
function hasCardCue(text: string, placeholder: string, agent = false): boolean {
  const words = text.split(placeholder).join(' ').split(CARD_NUMBER_PLACEHOLDER).join(' ');
  return (agent ? CARD_CUE : CALLER_CARD_CUE).test(words);
}

/**
 * Cheap pre-check: text with neither a digit nor a digit word cannot hold a
 * card number, so most prose skips the tokenizer.
 */
const MAY_HOLD_DIGITS = new RegExp(
  String.raw`\d|(?:^|[^\p{L}])(?:${[
    ...DIGIT_WORDS.keys(),
    ...ENGLISH_PAIR_WORDS.keys(),
    ...ENGLISH_TENS.keys(),
    ...SPANISH_PAIR_WORDS.keys(),
    ...SPANISH_TENS.keys(),
  ].join('|')})(?![\p{L}])`,
  'iu',
);

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
 * What a window is checked against beyond its digits: the turns of the run
 * that are themselves a phone number, and whether the card is mentioned
 * around it (`hasCardCue`).
 */
interface SearchContext {
  phoneTurns: ReadonlySet<number>;
  cardCue: boolean;
}

/**
 * Every payment card in PCI scope (Visa, Mastercard, Amex, Discover, JCB,
 * Diners, UnionPay) starts with 2–6. Required of every window that is not
 * written digits inside one turn (`cardShaped`).
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

/** 1900–2039: a year said in a list of them ("twenty eighteen", "2006"). */
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
 * scrubber's rules). Any window with digit words or pairs in it, or stitched
 * from several turns, must start like a payment card (2–6) and hold no more
 * year-shaped groups of four than a card does (`maxYearShapedGroups`). Digit
 * words said as one unbroken run must be a length cards are issued in
 * (`issuedAtLength`). Words and written digits mixed, or pairs, must be read
 * in a card's groups (`groupedLikeACard`), and a window with pairs in it must
 * have the card mentioned around it (`SearchContext.cardCue`): a list of
 * times, years, prices or house numbers is said in pairs too.
 *
 * A window stitched from several turns must also take in no turn that is
 * itself a phone number, and fall into its turns the way a card read aloud
 * does (`readLikeACard`). Callers answer an intake flow with bare numbers in
 * a row (a zip, a year, a house number, a callback number), and those joined
 * pass the Luhn check one time in ten; a caller reading a card pauses between
 * its groups instead. Where every turn gives four digits or fewer (a card
 * read group by group, or gate codes, last-four answers and years one per
 * turn, which nothing in the digits tells apart), the card must also be
 * mentioned around it (`SearchContext.cardCue`).
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
  if (!PAYMENT_CARD_FIRST_DIGIT.test(run)) return false;
  if (parts.length === 1 && spoken && !issuedAtLength(run)) return false;
  const { chunks, aligned } = windowChunks(parts);
  const pairs = parts.some((p) => p.units.some((u) => u.pair));
  const mixed = spoken && parts.some((p) => p.group.written);
  if ((pairs || mixed) && !groupedLikeACard(parts, chunks, aligned)) return false;
  // Read in pairs, four house numbers or a run of prices fall into fours
  // just as a card does; only a mention of the card tells them apart.
  if (pairs && !ctx.cardCue) return false;
  if (chunks.filter((c) => YEAR_SHAPED.test(c)).length > maxYearShapedGroups(ctx.cardCue)) return false;
  if (segs.length === 1) return true;
  // One group of four (or fewer) per turn; the last turn of a card that ends
  // on three may hold its last four and its last three together.
  const groupPerTurn = turnDigits.every((n, k) => n <= 4 || (k === turnDigits.length - 1 && n === 7 && endsOnThree(run)));
  return (
    // Never from the middle of a written number ("(236) 987-2420", then the
    // next turns).
    !parts[0].group.writtenJoin &&
    !segs.some((seg) => ctx.phoneTurns.has(seg)) &&
    readLikeACard(turnDigits, run) &&
    (ctx.cardCue || !groupPerTurn)
  );
}

/**
 * A card cut out of a spoken group is a guess at where the card ends inside
 * words said with no pause, so it takes only the lengths cards are mostly
 * issued in: 16 (Visa, Mastercard, Discover, JCB) or an Amex's 15, and 19
 * (Visa, UnionPay) when the cut keeps a code or expiry after the card. Every
 * other length is one more window that can pass the Luhn check by chance in
 * a long run of words that is no card (a reference number, two phone numbers
 * back to back): a 17–19 digit window after one or two stray words is how a
 * 20-digit pair of phone numbers became a "card".
 */
const MIN_CUT_PAN_DIGITS = 15;

function cutLength(digits: number, keepsWhatFollows: boolean): boolean {
  return digits === 15 || digits === 16 || (keepsWhatFollows && digits === MAX_PAN_DIGITS);
}

/**
 * At most this many digits of a spoken group may come before a card cut out
 * of it: a stray "oh" or "one" said straight before the card. A longer
 * lead-in is another number, and every start deeper into the run is one more
 * window that can pass the Luhn check by chance.
 */
const MAX_CUT_LEAD_DIGITS = 2;

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
 * cuatro noventa y ocho, cero cinco, cero nueve"): 3-3-2-2, 3-1-2-2-2, or a
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
function cardWindows(groups: DigitGroup[], cardCue: boolean): CardHit[] {
  const phoneTurns = new Set<number>();
  for (const seg of new Set(groups.map((g) => g.seg))) {
    const own = groups.filter((g) => g.seg === seg).map((g) => g.digits);
    if (spokenPhoneGroupsAt(own, 0) === own.length) phoneTurns.add(seg);
  }
  const ctx: SearchContext = { phoneTurns, cardCue };
  const whole = (from: number, to: number): WindowPart[] =>
    groups.slice(from, to + 1).map((group) => ({ group, units: group.units }));
  const hits: CardHit[] = [];
  // First group of the stretch no whole-group card has covered yet.
  let stretch = 0;
  for (const [first, last] of wholeGroupCards(
    groups.map((g) => g.digits),
    spokenPhoneGroupsAt,
    (from, to, run) => cardShaped(whole(from, to), run, ctx),
  )) {
    hits.push(...cutCardWindows(groups, stretch, first, ctx));
    hits.push(groupHit(groups, first, last));
    stretch = last + 1;
  }
  hits.push(...cutCardWindows(groups, stretch, groups.length, ctx));
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
 * card (`followsACard`), pass the Luhn check and keep `cardShaped`. Written
 * digits are one token per group, so the written path never gets here with
 * anything to cut.
 */
function cutCardWindows(groups: DigitGroup[], from: number, to: number, ctx: SearchContext): CardHit[] {
  const digits = groups.map((g) => g.digits);
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
        // Kept verbatim, as in the whole-group search.
        const next = units.findIndex((u) => u.group >= start.group + phone);
        if (next < 0) break;
        p = next;
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
      if (!cutLength(w.digits.length, !end.last)) return false;
      if (!end.last) {
        const rest = groups[end.group].units.slice(groups[end.group].units.findIndex((u) => u.token === end.token) + 1);
        if (!followsACard(rest.map((u) => u.digits).join(''), w.digits)) return false;
      }
      if (!isLuhnValid(w.digits)) return false;
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

/**
 * What a cross-turn search may read around the caller's turns without ever
 * stitching or rewriting it.
 */
export interface CardSplitContext {
  /**
   * What the agent said around the turns: its last line before the first of
   * them and every line between them ({@link agentLinesAround}). Read only
   * for a mention of the card itself (not of paying: the agent talks about
   * payment links while it takes gate codes and years).
   */
  agentLines?: readonly string[];
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
 * (`readLikeACard`), it holds at most one year-shaped group, and where every
 * turn gives four digits or fewer the card is mentioned in the turns, by the
 * agent around them (`context`), or by a turn that reads on ("the next four
 * are …", `READS_ON`). Bare intake answers in a row are left alone.
 * A card wholly inside one turn, and Deepgram's card tag, are replaced too,
 * so a stored row written before the scrubber comes out clean.
 *
 * Returns the turns rewritten (same length and order), or null when nothing
 * changed. The caller bounds the window ({@link cardSplitWindow}: the live
 * path in `VoiceSessionStore`, the recording boundary through
 * {@link redactCardNumbersInCallTurns}).
 */
export function redactCardNumbersAcrossTurns(
  turns: readonly string[],
  placeholder: string = CARD_NUMBER_PLACEHOLDER,
  context: CardSplitContext = {},
): string[] | null {
  const tagged = turns.map((text) => text.replace(DEEPGRAM_CARD_TAG, placeholder));
  const tokens: Token[] = [];
  let readsOn = false;
  for (const [seg, text] of tagged.entries()) {
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
    if (leadIn?.[1] !== undefined && READS_ON.test(leadIn[1])) readsOn = true;
    tokens.push({ kind: 'lead', seg, start: 0, end: lead.length, digits: '' });
    tokens.push(...turnTokens.filter((t) => t.start >= lead.length));
  }
  const cardCue =
    readsOn ||
    tagged.some((text) => hasCardCue(text, placeholder)) ||
    (context.agentLines ?? []).some((text) => hasCardCue(text, placeholder, true));
  // Per turn, the spans to replace: for each card, from the first to the last
  // of its digit tokens that sit in that turn.
  const spans: Array<Array<{ start: number; end: number }>> = tagged.map(() => []);
  for (const hit of findCardHits(tokens, cardCue)) {
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

/** The earlier caller turns (oldest first) a caller turn said at `at` is read together with. */
export function cardSplitWindow<T extends { at: number }>(earlier: readonly T[], at: number): T[] {
  return earlier.filter((t) => at - t.at <= CARD_SPLIT_WINDOW_MS).slice(-(CARD_SPLIT_WINDOW_TURNS - 1));
}

/** One line of a call leg, in the order it was said. */
interface CallLine {
  speaker: 'caller' | 'agent';
  text: string;
}

/**
 * What the agent said around a caller-turn window ({@link CardSplitContext}):
 * its last line before the window's first caller turn (`first`, an index into
 * `lines`) and every agent line from there up to `current` (exclusive).
 */
export function agentLinesAround(lines: readonly CallLine[], first: number, current: number): string[] {
  let from = first - 1;
  while (from > 0 && lines[from].speaker !== 'agent') from--;
  return lines
    .slice(Math.max(from, 0), current)
    .filter((line) => line.speaker === 'agent')
    .map((line) => line.text);
}

/**
 * A whole leg's turns (oldest first, both speakers, with the epoch ms each
 * was said), its caller turns read again exactly as the live path read them
 * as they were said: each caller turn in its {@link cardSplitWindow}, with the
 * earlier turns' text as already rewritten and the agent's lines around them
 * ({@link agentLinesAround}). The recording boundary runs this over the
 * stored rows, so a card whose live rewrite of those rows failed (or had not
 * landed yet) still leaves them before ingestion. Agent turns are never
 * rewritten. Returns the turns rewritten (same length and order), or null
 * when nothing changed.
 */
export function redactCardNumbersInCallTurns(turns: ReadonlyArray<CallLine & { at: number }>): string[] | null {
  const texts = turns.map((t) => t.text);
  let window: Array<{ k: number; at: number }> = [];
  let changed = false;
  turns.forEach(({ speaker, text, at }, k) => {
    if (speaker !== 'caller') return;
    const earlier = cardSplitWindow(window, at);
    // An empty utterance holds no digits and never joins the window.
    if (text.trim().length === 0) {
      window = earlier;
      return;
    }
    window = [...earlier, { k, at }];
    if (earlier.length === 0) return;
    const rewritten = redactCardNumbersAcrossTurns(
      window.map((t) => texts[t.k]),
      CARD_NUMBER_PLACEHOLDER,
      { agentLines: agentLinesAround(turns, window[0].k, k) },
    );
    rewritten?.forEach((next, j) => {
      if (next === texts[window[j].k]) return;
      texts[window[j].k] = next;
      changed = true;
    });
  });
  return changed ? texts : null;
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
