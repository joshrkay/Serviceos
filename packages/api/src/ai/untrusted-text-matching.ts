/**
 * RIVET I13 / #894 / #1229 — finding forged fence markers, chat-role tags and
 * `[BEGIN …]`/`[END …]` delimiters in caller-authored text the way a model
 * READS the text, and replacing them without rewriting anything else.
 *
 * ## Why a matching copy
 *
 * Normalising the text that is SENT (the #894 hardening) rewrote the caller's
 * numbers ("1½" → "11⁄2") and re-assembled tags an earlier pass had let
 * through. So normalisation happens only on a COPY used for matching. Each
 * character of the copy remembers the span of the ORIGINAL text it came from;
 * a match maps back to one contiguous original span, and only whole spans are
 * replaced. Every other character reaches the model byte-for-byte.
 *
 * ## What the copy folds
 *
 *   - HTML entities (`&#40;`, `&lt;`), JSON / JS escapes (`\u0028`, `\n`) and
 *     printable `%XX`, decoded twice so a double encoding folds too.
 *   - Compatibility forms (NFKC), then NFD with every combining mark dropped.
 *   - Invisible code points (`\p{Cf}`, CGJ, variation selectors, fillers,
 *     controls) are dropped.
 *   - Unicode tag characters U+E0020–E007E are read TWO ways — dropped (a
 *     person sees nothing) and decoded to their ASCII twins (some models
 *     decode them) — and a match in either copy counts (#1229 re-review).
 *   - Confusables come from generated Unicode data
 *     (`untrusted-confusables.generated.ts`: UTS #39 prototypes that are ASCII
 *     letters, digits or delimiters, plus small capitals), so Cyrillic, Greek,
 *     Lisu, Cherokee and stroke letters fold. ASCII letters and digits are
 *     never remapped; marker words instead TOLERATE `I`/`L`/`1` and `O`/`0`.
 *
 * ## Reader breaks
 *
 * Two readings decide where words break: a PERSON's (only a visible separator
 * breaks — `<sys` + ZWSP + `tem>` reads `<system>`) and a TOKENIZER's (a
 * dropped invisible, a decoded escape or a non-ASCII letter also breaks —
 * `[END` + ZWSP + `UNTRUSTED` reads `[END UNTRUSTED`). Role tags and bracket
 * delimiters match if EITHER reading shows them; a fence phrase needs a break
 * in some reading at both ends, so `we run trusted content` is not a match.
 *
 * ## Shapes (whole markers only)
 *
 *   - fence marker: `UNTRUSTED [CALLER['S]] CONTENT` or `CALLER['S] CONTENT`
 *     as whole words, with a BEGIN/START/END/STOP keyword before or after it,
 *     or directly wrapped in marker decoration (`===`, `[`, `<`, `#`, `*`).
 *     Replaced with its decoration; a bracket or paren is swallowed only as a
 *     pair around the marker, never a neighbour's.
 *   - role tag: `<`, separators, a role word (system, assistant, developer,
 *     instruction, prompt, tool, function — as the first word, prefix match),
 *     through the next `>`.
 *   - bracket delimiter: `[`, separators, BEGIN or END as a whole word, through
 *     the next `]` on the same line.
 *
 * Replacement runs to a fixpoint: removing a span can form a new one (a
 * role tag that crossed a line break), so matching repeats until nothing is
 * found. Tokens carry no delimiter characters, so a token can never close a
 * forged delimiter.
 *
 * ## Input cap
 *
 * `capUntrustedText` bounds ONE untrusted segment — a transcript, a message,
 * a turn — to MAX_UNTRUSTED_CONTENT_CHARS before matching, truncating visibly
 * (head and tail kept). Multi-message renderers cap each message separately.
 */
import { DELIMITER_CONFUSABLE_ENTRIES, LETTER_CONFUSABLE_ENTRIES } from './untrusted-confusables.generated';

/**
 * Cap on ONE untrusted segment, in UTF-16 code units: a single transcript, a
 * single message or a single turn. Matches the repo's transcript cap
 * (`MAX_TRANSCRIPT_CHARS` = 8000 in ai/tasks/onboarding/utils.ts) and sits well
 * above one caller surface: a voicemail records at most 120 s (≈2,000 chars),
 * an SMS is at most 1,600. Renderers that fence several messages or turns
 * (suggest-reply, context-builder recent messages, summarize-session) cap each
 * one separately — those are bounded by message/turn COUNT, and a
 * whole-conversation cap would cut its middle (#1229 re-review).
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
 * Bound one untrusted segment to MAX_UNTRUSTED_CONTENT_CHARS. Within the cap
 * the text is returned unchanged. Longer text keeps its head and tail and
 * replaces the middle with a visible `[… N characters of caller content
 * omitted …]` line. Never splits a surrogate pair; capping twice is a no-op.
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

/**
 * `text.slice(0, max)` that never leaves a lone high surrogate at the cut
 * (#1240 item 4): when the last kept code unit opens a pair, the pair is
 * dropped whole.
 */
export function sliceWithoutSplittingSurrogate(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

// ─── The matching copy ──────────────────────────────────────────────────────

/**
 * One character of the matching copy: `ch` is a single UTF-16 code unit
 * (astral leftovers are replaced by a placeholder), `start`/`end` the span of
 * the ORIGINAL text it was derived from.
 */
interface CopyUnit {
  ch: string;
  start: number;
  end: number;
}

function parseEntries(packed: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of packed.split(' ')) {
    if (!entry) continue;
    const [source, ...target] = [...entry];
    map.set(source, target.join(''));
  }
  return map;
}

/** UTS #39 (generated): folded non-ASCII code point → ASCII letters/digits. */
const LETTER_CONFUSABLES = parseEntries(LETTER_CONFUSABLE_ENTRIES);

/**
 * UTS #39 (generated) delimiter prototypes, plus bracket and rule shapes it
 * does not list — it maps look-alike LETTERS and punctuation, not the
 * mathematical / CJK styles of the same bracket: angle ⟨ 〈 ⧼, white and
 * lenticular square ⟦ 〚 【 〖 ⁅, flattened / white parens ❪ ⟮ ⦅, box-drawing
 * and modifier equals ═ ꞊ ⚌, horizontal bar ―.
 */
const DELIMITER_CONFUSABLES = new Map<string, string>([
  ...parseEntries(DELIMITER_CONFUSABLE_ENTRIES),
  ...(['⟨', '〈', '⧼'] as const).map((c) => [c, '<'] as const),
  ...(['⟩', '〉', '⧽'] as const).map((c) => [c, '>'] as const),
  ...(['⟦', '〚', '【', '〖', '⁅'] as const).map((c) => [c, '['] as const),
  ...(['⟧', '〛', '】', '〗', '⁆'] as const).map((c) => [c, ']'] as const),
  ...(['❪', '⟮', '⦅'] as const).map((c) => [c, '('] as const),
  ...(['❫', '⟯', '⦆'] as const).map((c) => [c, ')'] as const),
  ...(['═', '꞊', '⚌'] as const).map((c) => [c, '='] as const),
  ['―', '-'] as const,
]);

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
 * One decoding pass over `units`. Entities and escapes are ASCII (a tag-decoded
 * unit reads as its ASCII twin here), so a match of length k consumes exactly
 * k units, and the decoded character inherits their combined original span.
 */
function decodePass(units: CopyUnit[]): CopyUnit[] {
  const out: CopyUnit[] = [];
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (u.ch === '&' || u.ch === '\\' || u.ch === '%') {
      let ahead = '';
      for (let j = k; j < units.length && j < k + DECODE_LOOKAHEAD; j++) ahead += units[j].ch;
      const hit = decodeAt(ahead);
      if (hit && [...ahead.slice(0, hit[1])].length === hit[1]) {
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
    '\\u{E0000}-\\u{E007F}' + // the whole tag block, incl. unassigned code points (decoded separately, see buildMatchingCopy)
    '\\u115F\\u1160\\u3164\\uFFA0\\u2800\\u180B-\\u180F' + // Hangul fillers, braille blank, Mongolian FVS / vowel separator
    '\\u0000-\\u0008\\u000E-\\u001F\\u007F-\\u0084\\u0086-\\u009F' + // C0 / C1 controls (tab, line breaks, VT, FF, NEL handled as spacing)
    ']',
  'u',
);

/** Line breaks, kept as `\n` in the copy (bracket delimiters are single-line). */
const LINE_BREAK_RE = /[\n\r\u0085\u2028\u2029]/;

const ALNUM_RE = /[\p{L}\p{N}]/u;
/** Placeholder for an astral character that survives folding: keeps "is it a letter?" without breaking 1-unit indexing. */
const ASTRAL_LETTER_PLACEHOLDER = '\u0416'; // Ж — a letter no pattern word contains
const ASTRAL_OTHER_PLACEHOLDER = '\uFFFD';

function pushUnit(out: CopyUnit[], c: string, start: number, end: number): void {
  const cp = c.codePointAt(0)!;
  // Regional indicator symbols 🇦–🇿 read as letters.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
    out.push({ ch: String.fromCharCode(0x41 + cp - 0x1f1e6), start, end });
    return;
  }
  const ch = cp > 0xffff ? (ALNUM_RE.test(c) ? ASTRAL_LETTER_PLACEHOLDER : ASTRAL_OTHER_PLACEHOLDER) : c;
  out.push({ ch, start, end });
}

/** Fold one decoded code point into zero or more copy units. */
function foldUnit(u: CopyUnit, out: CopyUnit[]): void {
  const { ch, start, end } = u;
  const code = ch.charCodeAt(0);
  // ASCII fast path: already NFKC/NFD-stable, and ASCII is never remapped.
  if (ch.length === 1 && code < 0x80) {
    if (code === 0x0a || code === 0x0d) { out.push({ ch: '\n', start, end }); return; }
    if (code === 0x09 || code === 0x0b || code === 0x0c) { out.push({ ch: ' ', start, end }); return; }
    if (INVISIBLE_RE.test(ch)) return;
    out.push({ ch: ch.toUpperCase(), start, end });
    return;
  }
  if (LINE_BREAK_RE.test(ch)) { out.push({ ch: '\n', start, end }); return; }
  if (INVISIBLE_RE.test(ch)) return;
  for (const n of ch.normalize('NFKC').normalize('NFD')) {
    if (INVISIBLE_RE.test(n)) continue;
    if (/\s/u.test(n)) { out.push({ ch: LINE_BREAK_RE.test(n) ? '\n' : ' ', start, end }); continue; }
    if (n.charCodeAt(0) < 0x80) { out.push({ ch: n.toUpperCase(), start, end }); continue; }
    const delimiter = DELIMITER_CONFUSABLES.get(n);
    if (delimiter) { out.push({ ch: delimiter, start, end }); continue; }
    const upper = n.toUpperCase();
    const letters = LETTER_CONFUSABLES.get(n) ?? LETTER_CONFUSABLES.get(upper);
    if (letters) {
      for (const c of letters) out.push({ ch: c.toUpperCase(), start, end });
      continue;
    }
    for (const c of upper) pushUnit(out, c, start, end);
  }
}

type TagReading = 'drop' | 'decode';

/** Build the matching copy of `text`: tag characters dropped or decoded, entities decoded twice, folded. */
function buildMatchingCopy(text: string, tags: TagReading): CopyUnit[] {
  let units: CopyUnit[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = tags === 'decode' && cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : String.fromCodePoint(cp);
    units.push({ ch, start: i, end: i + len });
    i += len;
  }
  units = decodePass(decodePass(units));
  const folded: CopyUnit[] = [];
  for (const u of units) foldUnit(u, folded);
  return folded;
}

const HAS_TAG_CHARACTERS = /[\u{E0020}-\u{E007E}]/u;

// ─── Reader breaks ──────────────────────────────────────────────────────────

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM_RE.test(ch);
}

/** A person reads a break between alphanumeric copy units i < j only when something visible sits between. */
function personBreak(i: number, j: number): boolean {
  return j !== i + 1;
}

function isPlainAscii(text: string, u: CopyUnit): boolean {
  return u.end - u.start === 1 && /[A-Za-z0-9]/.test(text[u.start]);
}

/**
 * A tokenizer also breaks at a dropped invisible (a gap in the original), a
 * decoded escape, or a non-ASCII character — main's `\b` did the same, and
 * `[END` + ZWSP + `UNTRUSTED …]` must read as `[END UNTRUSTED …]`.
 */
function tokenBreak(copy: CopyUnit[], text: string, i: number, j: number): boolean {
  if (j !== i + 1) return true;
  if (copy[j].start !== copy[i].end) return true;
  return !isPlainAscii(text, copy[i]) || !isPlainAscii(text, copy[j]);
}

type Breaks = (i: number, j: number) => boolean;

/**
 * The first word after `from`, read with `breaks`: the first alphanumeric
 * token, or — when it is a single letter — the run of single-letter tokens
 * that starts there (spaced letters `s y s t e m`). Stops at `stopAt` or any
 * character in `stops`.
 */
function firstWord(copy: CopyUnit[], from: number, stopAt: number, stops: string, breaks: Breaks): string {
  const tokens: string[] = [];
  let current = '';
  let prev = -1;
  for (let i = from; i < stopAt; i++) {
    const ch = copy[i].ch;
    if (stops.includes(ch)) break;
    if (!isAlnum(ch)) continue;
    if (prev >= 0 && breaks(prev, i)) {
      tokens.push(current);
      current = '';
      if (tokens[0].length > 1 || tokens[tokens.length - 1].length > 1) break;
    }
    current += ch;
    prev = i;
    if (current.length > 24) break;
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) return '';
  if (tokens[0].length > 1) return tokens[0];
  let word = '';
  for (const t of tokens) {
    if (t.length > 1) break;
    word += t;
  }
  return word;
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

// ─── Matchers ───────────────────────────────────────────────────────────────

export type ForgedSpanKind = 'fence-marker' | 'role-tag' | 'bracket-delimiter';

/** A half-open span [start, end) of the ORIGINAL text that reads as a forged boundary. */
interface ForgedSpan {
  start: number;
  end: number;
  kind: ForgedSpanKind;
}

/** Sentence punctuation: a keyword on the far side of one is prose, not part of a marker (#1240 item 3). */
const SENTENCE_PUNCTUATION = new Set(['.', ',', ';', '!', '?']);

/** Does the copy strictly between indices a < b hold sentence punctuation? */
function crossesSentence(copy: CopyUnit[], a: number, b: number): boolean {
  for (let i = a + 1; i < b; i++) if (SENTENCE_PUNCTUATION.has(copy[i].ch)) return true;
  return false;
}

/** Marker words tolerate the look-alike ASCII I/L/1 and O/0 without folding ordinary words. */
const I = '[IL1]';
const O = '[O0]';
const KEYWORD = `(?:BEG${I}N|START|END|ST${O}P)`;
const CALLER = `CA${I}${I}ERS?`;

/** Fence marker phrase on the alphanumeric copy: [keyword [OF] [THE]] core [keyword]. */
const FENCE_PHRASE_RE = new RegExp(
  `(${KEYWORD}(?:${O}F)?(?:THE)?)?` +
    `((?:UNTRUSTED(?:${CALLER})?|${CALLER})C${O}NTENT)` +
    `(${KEYWORD})?`,
  'g',
);

/** Horizontal decoration swallowed around a fence marker. */
const PLAIN_DECORATION = new Set([' ', '=', '#', '*', '~', '-', '_', '|']);
/** A bare fence phrase (no keyword) counts only when directly wrapped in one of these. */
const MARKER_DECORATION_BEFORE = new Set(['=', '[', '<', '#', '*', '~', '|']);
const MARKER_DECORATION_AFTER = new Set(['=', ']', '>', '#', '*', '~', '|']);
const PAIRS: ReadonlyArray<readonly [string, string]> = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];

function findFenceMarkers(copy: CopyUnit[], text: string, out: ForgedSpan[]): void {
  const alnumIdx: number[] = [];
  let alnum = '';
  for (let i = 0; i < copy.length; i++) {
    if (isAlnum(copy[i].ch)) {
      alnumIdx.push(i);
      alnum += copy[i].ch;
    }
  }
  const breakBefore = (a: number): boolean => a === 0 || tokenBreak(copy, text, alnumIdx[a - 1], alnumIdx[a]);
  const breakAfter = (a: number): boolean => a === alnumIdx.length - 1 || tokenBreak(copy, text, alnumIdx[a], alnumIdx[a + 1]);

  FENCE_PHRASE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_PHRASE_RE.exec(alnum)) !== null) {
    const leadLen = (m[1] ?? '').length;
    const trailLen = (m[3] ?? '').length;
    let first = m.index;
    let last = m.index + m[0].length - 1;
    let keyword = false;
    // #1240 item 3 — a keyword belongs to the marker only when no sentence
    // punctuation separates it from the core phrase: "I don't want caller
    // content. End of story." is prose, not "CALLER CONTENT END".
    if (leadLen > 0) {
      if (breakBefore(first) && !crossesSentence(copy, alnumIdx[first], alnumIdx[first + leadLen])) keyword = true;
      else first += leadLen; // "WEEKEND UNTRUSTED …": that END belongs to WEEKEND
    }
    if (trailLen > 0) {
      if (breakAfter(last) && !crossesSentence(copy, alnumIdx[last - trailLen], alnumIdx[last - trailLen + 1])) keyword = true;
      else last -= trailLen; // "… CONTENT ENDORSEMENT"
    }
    if (!breakBefore(first) || !breakAfter(last)) {
      FENCE_PHRASE_RE.lastIndex = m.index + 1; // "we run trusted content": not a word
      continue;
    }

    let s = alnumIdx[first];
    let e = alnumIdx[last];
    if (!keyword) {
      let l = s - 1;
      while (l >= 0 && copy[l].ch === ' ') l--;
      let r = e + 1;
      while (r < copy.length && copy[r].ch === ' ') r++;
      if (!MARKER_DECORATION_BEFORE.has(copy[l]?.ch) && !MARKER_DECORATION_AFTER.has(copy[r]?.ch)) {
        FENCE_PHRASE_RE.lastIndex = m.index + 1; // bare prose "untrusted content"
        continue;
      }
    }

    // Closers owed to openers inside the marker itself, e.g. the ")" of "(END)".
    const owed = new Map<string, number>();
    for (let i = s; i <= e; i++) {
      for (const [open, close] of PAIRS) {
        if (copy[i].ch === open) owed.set(close, (owed.get(close) ?? 0) + 1);
        if (copy[i].ch === close && (owed.get(close) ?? 0) > 0) owed.set(close, owed.get(close)! - 1);
      }
    }
    for (;;) {
      while (s > 0 && PLAIN_DECORATION.has(copy[s - 1].ch)) s--;
      while (e + 1 < copy.length) {
        const next = copy[e + 1].ch;
        if (PLAIN_DECORATION.has(next)) e++;
        else if ((owed.get(next) ?? 0) > 0) { owed.set(next, owed.get(next)! - 1); e++; }
        else break;
      }
      const pair = PAIRS.find(([open, close]) => copy[s - 1]?.ch === open && copy[e + 1]?.ch === close);
      if (!pair) break;
      s--;
      e++;
    }
    while (s < alnumIdx[first] && copy[s].ch === ' ') s++;
    while (e > alnumIdx[last] && copy[e].ch === ' ') e--;
    out.push({ start: copy[s].start, end: copy[e].end, kind: 'fence-marker' });
    FENCE_PHRASE_RE.lastIndex = last + 1;
  }
}

const ROLE_WORD_RE = new RegExp(`^(?:SYSTEM|ASSISTANT|DEVE${I}${O}PER|${I}NSTRUCT${I}${O}N|PR${O}MPT|T${O}${O}${I}|FUNCT${I}${O}N)`);

/**
 * `<` … role word … `>` — the shape `neutralizeUntrusted` has always redacted
 * (`<\/?\s*(system|…)[^>]*>`), read on the copy: the role word is the FIRST
 * word after `<` (any separators before it; spaced letters allowed), prefix
 * match as before (`<tools>`), in a person's or a tokenizer's reading. The tag
 * runs to the next `>`. `<to Olivia>` is not a tag.
 */
function findRoleTags(copy: CopyUnit[], text: string, out: ForgedSpan[]): void {
  const nextGt = nextIndexOf(copy, '>', false);
  for (let p = 0; p < copy.length; p++) {
    if (copy[p].ch !== '<') continue;
    const gt = nextGt[p + 1];
    if (gt < 0) break; // no '>' anywhere after — no later '<' can close either
    const person = firstWord(copy, p + 1, gt, '<', personBreak);
    const token = firstWord(copy, p + 1, gt, '<', (i, j) => tokenBreak(copy, text, i, j));
    if (!ROLE_WORD_RE.test(person) && !ROLE_WORD_RE.test(token)) continue;
    out.push({ start: copy[p].start, end: copy[gt].end, kind: 'role-tag' });
    p = gt;
  }
}

const BRACKET_KEYWORD_RE = new RegExp(`^(?:BEG${I}N|END)$`);

/**
 * `[` BEGIN|END … `]` on one line — the shape `neutralizeUntrusted` has always
 * redacted (`\[\s*(BEGIN|END)\b[^\]\n]*\]`), read on the copy: the keyword is
 * the whole first word in a person's or a tokenizer's reading, so
 * `[END` + ZWSP + `UNTRUSTED …]` matches while `[Beginner]` and
 * `[ending soon]` do not.
 */
function findBracketDelimiters(copy: CopyUnit[], text: string, out: ForgedSpan[]): void {
  const nextClose = nextIndexOf(copy, ']', true);
  for (let p = 0; p < copy.length; p++) {
    if (copy[p].ch !== '[') continue;
    const close = nextClose[p + 1];
    if (close < 0) continue;
    const person = firstWord(copy, p + 1, close, '[', personBreak);
    const token = firstWord(copy, p + 1, close, '[', (i, j) => tokenBreak(copy, text, i, j));
    if (!BRACKET_KEYWORD_RE.test(person) && !BRACKET_KEYWORD_RE.test(token)) continue;
    out.push({ start: copy[p].start, end: copy[close].end, kind: 'bracket-delimiter' });
    p = close;
  }
}

function findForgedSpans(text: string, kinds: ReadonlyArray<ForgedSpanKind>): ForgedSpan[] {
  const spans: ForgedSpan[] = [];
  const readings: TagReading[] = HAS_TAG_CHARACTERS.test(text) ? ['drop', 'decode'] : ['drop'];
  for (const reading of readings) {
    const copy = buildMatchingCopy(text, reading);
    if (kinds.includes('fence-marker')) findFenceMarkers(copy, text, spans);
    if (kinds.includes('role-tag')) findRoleTags(copy, text, spans);
    if (kinds.includes('bracket-delimiter')) findBracketDelimiters(copy, text, spans);
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * The replacement for forged spans: one string for every kind, or one per kind
 * (#1240 item 2 — a single fixpoint over several kinds, each still replaced
 * with its own token).
 */
export type ForgedSpanTokens = string | Readonly<Partial<Record<ForgedSpanKind, string>>>;

function tokenFor(tokens: ForgedSpanTokens, kind: ForgedSpanKind): string {
  if (typeof tokens === 'string') return tokens;
  const token = tokens[kind];
  if (token === undefined) throw new Error(`neutralizeForgedText: no replacement token for ${kind}`);
  return token;
}

/** Replace each span (overlaps merged; the first span's token wins) with its token; every character outside a span is kept. */
function replaceSpans(text: string, spans: ReadonlyArray<ForgedSpan>, tokens: ForgedSpanTokens): string {
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < spans.length) {
    const start = spans[i].start;
    const token = tokenFor(tokens, spans[i].kind);
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

/**
 * Bound on replacement passes. A pass only finds a new span where the previous
 * pass removed a line break or delimiter inside one, so real input settles in
 * one or two; past the bound, everything from the first remaining span to the
 * last is replaced as one.
 */
const MAX_NEUTRALIZE_PASSES = 16;

/**
 * Replace every span of `text` that reads as a forged boundary of one of
 * `kinds` with its token, repeating until none is left. Tokens must contain no
 * delimiter characters. Callers cap `text` first (`capUntrustedText`).
 *
 * Pass every kind a prompt needs in ONE call (#1240 item 2): separate passes
 * per kind let one pass's replacement build a live span of another kind — a
 * fence marker split across a line break inside a forged `[END …` became
 * `[END … (fence-marker) ]`, a closed delimiter the earlier pass never saw.
 */
export function neutralizeForgedText(text: string, kinds: ReadonlyArray<ForgedSpanKind>, token: ForgedSpanTokens): string {
  let current = text;
  for (let pass = 0; pass < MAX_NEUTRALIZE_PASSES; pass++) {
    if (current.length === 0) return current;
    const spans = findForgedSpans(current, kinds);
    if (spans.length === 0) return current;
    current = replaceSpans(current, spans, token);
  }
  const rest = findForgedSpans(current, kinds);
  if (rest.length === 0) return current;
  const end = Math.max(...rest.map((s) => s.end));
  return replaceSpans(current, [{ start: rest[0].start, end, kind: rest[0].kind }], token);
}
