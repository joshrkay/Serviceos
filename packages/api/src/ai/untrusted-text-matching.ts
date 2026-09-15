/**
 * RIVET I13 / #894 / #1229 review — finding forged fence markers, chat-role
 * tags and `[BEGIN …]`/`[END …]` delimiters in caller-authored text, the way a
 * model READS the text rather than the way its bytes compare.
 *
 * ## Why a matching copy
 *
 * The #894 hardening normalised (NFKC) and stripped the text it then sent to
 * the model. That broke twice (PR #1229 security review):
 *
 *   1. It ran AFTER the role-tag redaction, so a fullwidth `＜system＞` or a
 *      `<sys` + ZWSP + `tem>` passed the tag check as "not a tag" and was then
 *      re-assembled into a literal, live `<system>` in the request.
 *   2. It rewrote benign characters the model then read as different values:
 *      "1½ inch" became "11⁄2 inch", "4²" became "42".
 *
 * So normalisation happens only on a COPY used for matching. Each character
 * of the copy remembers the span of the ORIGINAL text it came from; a match on
 * the copy maps back to one contiguous original span, and only that whole span
 * is replaced. Every character outside a matched span reaches the model
 * byte-for-byte — nothing is ever removed from between two surviving
 * characters, so nothing can be re-assembled.
 *
 * ## What the copy folds (reader-equivalence, not a blocklist)
 *
 *   - HTML entities (`&#40;`, `&#x28;`, `&lt;`) and JSON / JS escapes
 *     (`\u0028`, `\n`), decoded twice so a double encoding folds too; `%XX`
 *     for printable ASCII.
 *   - Unicode compatibility forms (NFKC), then canonical decomposition with
 *     every combining mark dropped (so `É` reads as `E`).
 *   - Invisible code points: every `\p{Cf}` (ZWSP, ZWJ, LRM, BOM, soft hyphen,
 *     tag characters …), every combining mark incl. U+034F CGJ and the
 *     variation selectors U+FE00–FE0F / U+E0100–E01EF, the whole tag block
 *     U+E0000–E007F, Hangul / braille fillers, and C0/C1 controls.
 *   - Confusables: Cyrillic, Greek, Armenian, Cherokee and small-capital
 *     letters that render as Latin; regional-indicator letters; `0`→`O`,
 *     `1`/`l`→`I` (the pattern words fold the same way, so `CALLER` is
 *     matched as `CAIIER`). Case is ignored.
 *   - Delimiter lookalikes: angle / square brackets, solidus, dashes, the
 *     box-drawing and double-hyphen `=`s, ornamental parens.
 *
 * Separator tolerance: fence-marker words are matched on the LETTERS AND
 * DIGITS of the copy only, so `- END`, `: END`, `END_UNTRUSTED`, spaced
 * `E N D` and a line break between words all read as the same phrase. That
 * match is a literal-anchored regex over one alphanumeric string — linear, no
 * nested quantifiers — and every other scan is a single pass with
 * precomputed next-delimiter indices.
 *
 * ## Input cap
 *
 * `capUntrustedText` bounds every input to MAX_UNTRUSTED_CONTENT_CHARS before
 * any matching runs (the #894 regex was quadratic: 32k `=` took 3.3 s), and
 * truncates VISIBLY, keeping the head and the tail.
 *
 * This module only FINDS spans and caps text. The renderers that decide what
 * replaces a span live in `untrusted-content.ts` (fence markers) and
 * `agents/customer-calling/untrusted-content.ts` (role tags, brackets).
 */

/**
 * Cap on caller-authored text entering one untrusted-content fence, in UTF-16
 * code units. Matches the repo's transcript cap (`MAX_TRANSCRIPT_CHARS` = 8000
 * in ai/tasks/onboarding/utils.ts) and sits well above what a single caller
 * surface produces: a voicemail is recorded for at most 120 s (≈2,000 chars
 * of speech), the retrieved-notes section is capped at 4,000
 * (`MAX_RETRIEVED_SECTION_CHARS`). Over the cap, the middle is elided with a
 * visible notice (see `capUntrustedText`).
 */
export const MAX_UNTRUSTED_CONTENT_CHARS = 8000;

/** Room kept for the truncation notice, so a capped result is itself within the cap (idempotent). */
const TRUNCATION_NOTICE_RESERVE = 64;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Bound caller text to MAX_UNTRUSTED_CONTENT_CHARS. Text within the cap is
 * returned unchanged. Longer text keeps its head (the start of a voicemail)
 * and its tail (the newest message of a thread) and replaces the middle with
 * a visible `[… N characters of caller content omitted …]` line, so the model
 * — and anyone reading the prompt — can see it was cut. Never splits a
 * surrogate pair. The result is within the cap, so capping twice is a no-op.
 */
export function capUntrustedText(text: string): string {
  if (text.length <= MAX_UNTRUSTED_CONTENT_CHARS) return text;
  const keep = MAX_UNTRUSTED_CONTENT_CHARS - TRUNCATION_NOTICE_RESERVE;
  let headEnd = Math.floor(keep / 2);
  let tailStart = text.length - (keep - headEnd);
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n[… ${omitted} characters of caller content omitted …]\n${text.slice(tailStart)}`;
}

// ─── The matching copy ──────────────────────────────────────────────────────

/**
 * One character of the matching copy: `ch` is a single UTF-16 code unit
 * (astral leftovers are replaced by a placeholder, below), `start`/`end` the
 * span of the ORIGINAL text it was derived from.
 */
interface CopyUnit {
  ch: string;
  start: number;
  end: number;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"],
  ['lpar', '('], ['rpar', ')'], ['lsqb', '['], ['rsqb', ']'], ['lbrack', '['], ['rbrack', ']'],
  ['lcub', '{'], ['rcub', '}'], ['lbrace', '{'], ['rbrace', '}'], ['equals', '='], ['sol', '/'],
  ['bsol', '\\'], ['colon', ':'], ['lowbar', '_'], ['hyphen', '-'], ['dash', '-'], ['nbsp', ' '],
  ['num', '#'], ['period', '.'], ['comma', ','], ['excl', '!'], ['quest', '?'], ['vert', '|'],
]);

const ENTITY_RE = /^&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z]{2,8});)/;
const ESCAPE_RE = /^\\(?:u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|x([0-9a-fA-F]{2})|([nrtfv])|(["'/\\]))/;
const PERCENT_RE = /^%([2-7][0-9a-fA-F])/;
/** Longest entity / escape the decoder looks ahead for, in code points. */
const DECODE_LOOKAHEAD = 12;

function codePointString(cp: number): string | undefined {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/** Decode one entity / escape at the head of `ahead`; returns [decoded, consumed code points]. */
function decodeAt(ahead: string): [string, number] | undefined {
  const lead = ahead[0];
  if (lead === '&') {
    const m = ENTITY_RE.exec(ahead);
    if (!m) return undefined;
    const decoded =
      m[1] !== undefined ? codePointString(Number(m[1]))
        : m[2] !== undefined ? codePointString(parseInt(m[2], 16))
          : NAMED_ENTITIES.get(m[3].toLowerCase());
    return decoded === undefined ? undefined : [decoded, m[0].length];
  }
  if (lead === '\\') {
    const m = ESCAPE_RE.exec(ahead);
    if (!m) return undefined;
    const hex = m[1] ?? m[2] ?? m[3];
    const decoded =
      hex !== undefined ? codePointString(parseInt(hex, 16))
        : m[4] !== undefined ? ' '
          : m[5];
    return decoded === undefined ? undefined : [decoded, m[0].length];
  }
  if (lead === '%') {
    const m = PERCENT_RE.exec(ahead);
    if (!m || m[1].toLowerCase() === '7f') return undefined;
    return [String.fromCharCode(parseInt(m[1], 16)), m[0].length];
  }
  return undefined;
}

/**
 * One decoding pass over `units` (each a single code point here). Entities and
 * escapes are ASCII, so a match of length k consumes exactly k units, and the
 * decoded character inherits their combined original span.
 */
function decodePass(units: CopyUnit[]): CopyUnit[] {
  const out: CopyUnit[] = [];
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (u.ch === '&' || u.ch === '\\' || u.ch === '%') {
      let ahead = '';
      for (let j = k; j < units.length && j < k + DECODE_LOOKAHEAD; j++) ahead += units[j].ch;
      const hit = decodeAt(ahead);
      if (hit) {
        const [decoded, consumed] = hit;
        const span = { start: u.start, end: units[k + consumed - 1].end };
        for (const c of decoded) out.push({ ch: c, ...span });
        k += consumed - 1;
        continue;
      }
    }
    out.push(u);
  }
  return out;
}

/** Invisible to a reader — dropped from the copy (never from the output). */
const INVISIBLE_RE = new RegExp(
  '[' +
    '\\p{Cf}\\p{M}\\p{Cs}\\p{Co}' + // format chars (ZWSP, ZWJ, LRM, BOM, soft hyphen, tag chars), combining marks, lone surrogates, private use
    '\\u034F\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}' + // CGJ, variation selectors (also \p{M}; named for the reader)
    '\\u{E0000}-\\u{E007F}' + // the whole tag block, incl. unassigned code points
    '\\u115F\\u1160\\u3164\\uFFA0\\u2800\\u180B-\\u180F' + // Hangul fillers, braille blank, Mongolian FVS / vowel separator
    '\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u0084\\u0086-\\u009F' + // C0 / C1 controls (tab, line breaks, VT, FF, NEL handled as spacing)
    ']',
  'u',
);

/** Line breaks, kept as `\n` in the copy (bracket delimiters are single-line). */
const LINE_BREAK_RE = /[\n\r\u0085\u2028\u2029]/;

function pairs(spec: string): Map<string, string> {
  const map = new Map<string, string>();
  const cps = [...spec];
  for (let i = 0; i + 1 < cps.length; i += 2) map.set(cps[i], cps[i + 1]);
  return map;
}

/**
 * Lowercase lookalikes whose UPPERCASE form does not look Latin (Cyrillic
 * `г`→r / `п`→n, Greek `ν`→v / `η`→n, small capitals …). Applied before
 * uppercasing. Written as consecutive (lookalike, Latin) pairs.
 */
const LOWER_CONFUSABLES = pairs(
  'аaвbгrеeкkмmоoпnрpсcуyхxьbѕsіiјjԁdһhԛqԝwӏlүy' +
  'αaβbγyεeηnιiκkμuνvοoρpτtυuχxωwϲcϳjɑaɡgɩiȷj' +
  'օoսuոnհhզq' +
  'ᴀaʙbᴄcᴅdᴇeꜰfɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpʀrꜱsᴛtᴜuᴠvᴡwʏyᴢz',
);

/** Uppercase lookalikes → Latin capitals, plus the digit and I/l folds. Applied after uppercasing. */
const UPPER_CONFUSABLES = pairs(
  'АAВBЕEКKМMНHОOРPСCТTУYХXЅSІIЈJԀDԚQԜWӀIҮYҺH' +
  'ΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧXϹCͿJ' +
  'ՕOՍUԼI' +
  'ᎪAᏴBᏟCᎠDᎬEᏀGᎻHᎫJᏦKᏞIᎷMᏢPᏚSᎢTᏙVᏔWᏃZ' +
  '0O1ILI',
);

/** Delimiter lookalikes NFKC leaves alone → the ASCII delimiter the matchers look for. */
const DELIMITER_CONFUSABLES = new Map<string, string>([
  // <  single / double angle quotation, CJK + mathematical angle brackets, modifier / Canadian syllabics, ornaments
  ...['‹', '〈', '〈', '⟨', '˂', 'ᐸ', '❮', '⧼'].map((c) => [c, '<'] as const),
  // >
  ...['›', '〉', '〉', '⟩', '˃', 'ᐳ', '❯', '⧽'].map((c) => [c, '>'] as const),
  // /  division slash, fraction slash, big solidus, box-drawing diagonal
  ...['∕', '⁄', '⧸', '╱'].map((c) => [c, '/'] as const),
  // [ ]  white / lenticular / tortoise-shell / corner-ish CJK and mathematical brackets
  ...['⟦', '〚', '【', '〔', '〖', '⁅', '❲'].map((c) => [c, '['] as const),
  ...['⟧', '〛', '】', '〕', '〗', '⁆', '❳'].map((c) => [c, ']'] as const),
  // =  box-drawing double horizontal, double hyphen, katakana double hyphen, modifier equals, ⩵ ⩶, ⚌
  ...['═', '⹀', '゠', '꞊', '⩵', '⩶', '⚌'].map((c) => [c, '='] as const),
  // ( )  ornamental / mathematical parens
  ...['❨', '❪', '⟮', '⦅'].map((c) => [c, '('] as const),
  ...['❩', '❫', '⟯', '⦆'].map((c) => [c, ')'] as const),
  // -  hyphen, non-breaking hyphen, figure / en / em dash, horizontal bar, minus, hyphen bullet
  ...['‐', '‑', '‒', '–', '—', '―', '−', '⁃'].map((c) => [c, '-'] as const),
]);

const ALNUM_RE = /[\p{L}\p{N}]/u;
/** Placeholder for an astral character that survives folding: keeps "is it a letter?" without breaking 1-unit indexing. */
const ASTRAL_LETTER_PLACEHOLDER = '\u0416'; // Ж — a letter no pattern word contains
const ASTRAL_OTHER_PLACEHOLDER = '\uFFFD';

function pushFolded(out: CopyUnit[], c: string, start: number, end: number): void {
  const cp = c.codePointAt(0)!;
  // Regional indicator symbols 🇦–🇿 read as letters.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    out.push({ ch: String.fromCharCode(0x41 + cp - 0x1f1e6), start, end });
    return;
  }
  let ch = c;
  if (cp > 0xffff) ch = ALNUM_RE.test(c) ? ASTRAL_LETTER_PLACEHOLDER : ASTRAL_OTHER_PLACEHOLDER;
  out.push({ ch, start, end });
}

/** Fold one decoded code point into zero or more copy units. */
function foldUnit(u: CopyUnit, out: CopyUnit[]): void {
  const { ch, start, end } = u;
  const code = ch.charCodeAt(0);
  // ASCII fast path: already NFKC/NFD-stable.
  if (ch.length === 1 && code < 0x80) {
    if (code === 0x0a || code === 0x0d) { out.push({ ch: '\n', start, end }); return; }
    if (code === 0x09 || code === 0x0b || code === 0x0c) { out.push({ ch: ' ', start, end }); return; }
    if (INVISIBLE_RE.test(ch)) return;
    const up = ch.toUpperCase();
    out.push({ ch: UPPER_CONFUSABLES.get(up) ?? up, start, end });
    return;
  }
  if (LINE_BREAK_RE.test(ch)) { out.push({ ch: '\n', start, end }); return; }
  if (INVISIBLE_RE.test(ch)) return;
  for (const n of ch.normalize('NFKC').normalize('NFD')) {
    if (INVISIBLE_RE.test(n)) continue;
    if (/\s/u.test(n)) { out.push({ ch: LINE_BREAK_RE.test(n) ? '\n' : ' ', start, end }); continue; }
    const delimiter = DELIMITER_CONFUSABLES.get(n);
    if (delimiter) { out.push({ ch: delimiter, start, end }); continue; }
    const lower = LOWER_CONFUSABLES.get(n) ?? n;
    for (const up of lower.toUpperCase()) {
      pushFolded(out, UPPER_CONFUSABLES.get(up) ?? up, start, end);
    }
  }
}

/** Build the matching copy of `text`: decoded twice, folded, invisibles dropped. */
function buildMatchingCopy(text: string): CopyUnit[] {
  let units: CopyUnit[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    units.push({ ch: String.fromCodePoint(cp), start: i, end: i + len });
    i += len;
  }
  units = decodePass(decodePass(units));
  const folded: CopyUnit[] = [];
  for (const u of units) foldUnit(u, folded);
  return folded;
}

/** Fold a pattern word exactly as caller text is folded (`CALLER` → `CAIIER`). */
function foldWord(word: string): string {
  return buildMatchingCopy(word).map((u) => u.ch).join('');
}

// ─── Matchers ───────────────────────────────────────────────────────────────

export type ForgedSpanKind = 'fence-marker' | 'role-tag' | 'bracket-delimiter';

/** A half-open span [start, end) of the ORIGINAL text that reads as a forged boundary. */
export interface ForgedSpan {
  start: number;
  end: number;
  kind: ForgedSpanKind;
}

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM_RE.test(ch);
}

const BOUNDARY_WORDS = ['BEGIN', 'START', 'END', 'STOP'].map(foldWord);
const BOUNDARY = `(${BOUNDARY_WORDS.join('|')})`;

/**
 * The fence marker phrase on the alphanumeric copy: "UNTRUSTED [CALLER]
 * CONTENT", optionally preceded by "BEGIN/END [OF] [THE]" or followed by
 * BEGIN/END. The bare phrase is neutralised too — it names the fence, and no
 * caller has a benign reason to say it.
 */
const FENCE_PHRASE_RE = new RegExp(
  `(?:${BOUNDARY}(${foldWord('OF')})?(${foldWord('THE')})?)?` +
    `${foldWord('UNTRUSTED')}(?:${foldWord('CALLER')})?${foldWord('CONTENT')}` +
    `${BOUNDARY}?`,
  'g',
);

/** Decoration swallowed around a fence-marker phrase (`=== … ===`, parens), never across a line. */
const FENCE_DECORATION = new Set([' ', '=', '(', ')', '[', ']', '{', '}', '-', '_', '*', '#', '~']);

function findFenceMarkers(copy: CopyUnit[], out: ForgedSpan[]): void {
  const alnumIdx: number[] = [];
  let alnum = '';
  for (let i = 0; i < copy.length; i++) {
    if (isAlnum(copy[i].ch)) {
      alnumIdx.push(i);
      alnum += copy[i].ch;
    }
  }
  /** A reader sees a word break before alnum position `a` (something non-alphanumeric sat between). */
  const breakBefore = (a: number): boolean => a === 0 || alnumIdx[a] - alnumIdx[a - 1] > 1;

  FENCE_PHRASE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_PHRASE_RE.exec(alnum)) !== null) {
    let first = m.index;
    let last = m.index + m[0].length - 1;
    // A leading BEGIN/END glued to a previous word ("WEEKEND UNTRUSTED …") is that word's tail, not a boundary.
    const leadLen = (m[1] ?? '').length + (m[2] ?? '').length + (m[3] ?? '').length;
    if (leadLen > 0 && !breakBefore(first)) first += leadLen;
    // Likewise a trailing BEGIN/END running into more letters ("… CONTENT ENDORSEMENT").
    const trailLen = (m[4] ?? '').length;
    if (trailLen > 0 && last + 1 < alnumIdx.length && !breakBefore(last + 1)) last -= trailLen;

    let s = alnumIdx[first];
    let e = alnumIdx[last];
    while (s > 0 && FENCE_DECORATION.has(copy[s - 1].ch)) s--;
    while (e + 1 < copy.length && FENCE_DECORATION.has(copy[e + 1].ch)) e++;
    while (s < alnumIdx[first] && copy[s].ch === ' ') s++;
    while (e > alnumIdx[last] && copy[e].ch === ' ') e--;
    out.push({ start: copy[s].start, end: copy[e].end, kind: 'fence-marker' });
  }
}

/**
 * Read up to `want` letters/digits after position `from`, tolerating
 * separators between them but stopping at any `stops` character. Returns the
 * letters and the copy index of each.
 */
function readWord(
  copy: CopyUnit[],
  from: number,
  want: number,
  stops: string,
): { word: string; at: number[] } {
  let word = '';
  const at: number[] = [];
  const limit = Math.min(copy.length, from + want * 4 + 16);
  for (let i = from; i < limit && word.length < want; i++) {
    const ch = copy[i].ch;
    if (stops.includes(ch)) break;
    if (isAlnum(ch)) {
      word += ch;
      at.push(i);
    }
  }
  return { word, at };
}

/** For every index, the nearest index at or after it holding `ch` (or -1). One backward pass. */
function nextIndexOf(copy: CopyUnit[], ch: string, stopAtLineBreak: boolean): Int32Array {
  const next = new Int32Array(copy.length + 1).fill(-1);
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].ch === ch) next[i] = i;
    else if (stopAtLineBreak && copy[i].ch === '\n') next[i] = -1;
    else next[i] = next[i + 1];
  }
  return next;
}

const ROLE_WORDS = ['SYSTEM', 'ASSISTANT', 'DEVELOPER', 'INSTRUCTION', 'PROMPT', 'TOOL', 'FUNCTION'].map(foldWord);
const LONGEST_ROLE_WORD = Math.max(...ROLE_WORDS.map((w) => w.length));

/**
 * `<` … role word … `>` — the shape `neutralizeUntrusted` has always redacted
 * (`<\/?\s*(system|…)[^>]*>`), read on the copy: any separators before or
 * inside the role word (`< / sys tem >`), a prefix match on the role word as
 * before (`<tools>`), and the tag runs to the next `>`.
 */
function findRoleTags(copy: CopyUnit[], out: ForgedSpan[]): void {
  const nextGt = nextIndexOf(copy, '>', false);
  for (let p = 0; p < copy.length; p++) {
    if (copy[p].ch !== '<') continue;
    const gt = nextGt[p + 1];
    if (gt < 0) break; // no '>' anywhere after — no later '<' can close either
    const { word } = readWord(copy, p + 1, LONGEST_ROLE_WORD, '<>');
    if (!ROLE_WORDS.some((w) => word.startsWith(w))) continue;
    out.push({ start: copy[p].start, end: copy[gt].end, kind: 'role-tag' });
    p = gt;
  }
}

const BRACKET_WORDS = ['BEGIN', 'END'].map(foldWord);

/**
 * `[` BEGIN|END … `]` on one line — the shape `neutralizeUntrusted` has always
 * redacted (`\[\s*(BEGIN|END)\b[^\]\n]*\]`), read on the copy. `\b` becomes
 * "the next letter is not glued to the keyword", so `[Beginner]` and
 * `[ending soon]` are left alone.
 */
function findBracketDelimiters(copy: CopyUnit[], out: ForgedSpan[]): void {
  const nextClose = nextIndexOf(copy, ']', true);
  for (let p = 0; p < copy.length; p++) {
    if (copy[p].ch !== '[') continue;
    const close = nextClose[p + 1];
    if (close < 0) continue;
    const { word, at } = readWord(copy, p + 1, 6, '[]\n');
    const keyword = BRACKET_WORDS.find((w) => word.startsWith(w));
    if (!keyword) continue;
    const afterKeyword = at[keyword.length];
    if (afterKeyword !== undefined && afterKeyword === at[keyword.length - 1] + 1) continue;
    out.push({ start: copy[p].start, end: copy[close].end, kind: 'bracket-delimiter' });
    p = close;
  }
}

/**
 * Every span of `text` a reader sees as a forged boundary of one of `kinds`,
 * sorted by start. Callers cap `text` first (`capUntrustedText`).
 */
export function findForgedSpans(text: string, kinds: ReadonlyArray<ForgedSpanKind>): ForgedSpan[] {
  if (text.length === 0) return [];
  const copy = buildMatchingCopy(text);
  const spans: ForgedSpan[] = [];
  if (kinds.includes('fence-marker')) findFenceMarkers(copy, spans);
  if (kinds.includes('role-tag')) findRoleTags(copy, spans);
  if (kinds.includes('bracket-delimiter')) findBracketDelimiters(copy, spans);
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Replace each span of `text` (overlapping spans merged) with `token`. Every
 * character outside a span is kept byte-for-byte.
 */
export function replaceForgedSpans(text: string, spans: ReadonlyArray<ForgedSpan>, token: string): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < spans.length) {
    const start = spans[i].start;
    let end = spans[i].end;
    i++;
    while (i < spans.length && spans[i].start < end) {
      end = Math.max(end, spans[i].end);
      i++;
    }
    out += text.slice(cursor, Math.max(cursor, start)) + token;
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}
