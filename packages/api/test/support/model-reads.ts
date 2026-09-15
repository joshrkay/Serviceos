/**
 * #1229 review — an INDEPENDENT oracle for "what does a model read here?",
 * used to prove caller text reaching a prompt carries no live fence marker,
 * chat-role tag, or `[BEGIN …]`/`[END …]` delimiter, however it is spelled.
 *
 * Deliberately NOT built on the production neutraliser (a test that asks the
 * code under test whether it worked proves nothing). Text is read three ways
 * and counts as live if ANY reading shows the boundary:
 *
 *   1. a person's reading — invisible format characters, combining marks and
 *      variation selectors vanish, so `<sys` + ZWSP + `tem>` reads `<system>`;
 *   2. a tokenizer's reading — each invisible character is a word break, so
 *      `[END` + ZWSP + `UNTRUSTED …]` reads `[END UNTRUSTED …]`;
 *   3. a tag-decoding model's reading — Unicode tag characters
 *      U+E0020–E007E are their ASCII twins.
 *
 * Each reading decodes HTML entities and JSON escapes, folds compatibility
 * forms (NFKC), folds the Cyrillic / Greek / Lisu / stroke homoglyphs the
 * tests plant, and ignores case.
 */

/** The homoglyphs the #1229 probes plant (Cyrillic, Greek, Lisu, stroke letters that render as Latin). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  'А': 'A', 'а': 'a', 'В': 'B', 'С': 'C', 'с': 'c', 'Е': 'E', 'е': 'e', 'Н': 'H', 'І': 'I', 'і': 'i',
  'К': 'K', 'М': 'M', 'О': 'O', 'о': 'o', 'Р': 'P', 'р': 'p', 'Ѕ': 'S', 'ѕ': 's', 'Т': 'T', 'Х': 'X', 'у': 'y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'ο': 'o',
  'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  // Lisu
  'ꓮ': 'A', 'ꓚ': 'C', 'ꓓ': 'D', 'ꓰ': 'E', 'ꓡ': 'L', 'ꓠ': 'N', 'ꓳ': 'O', 'ꓣ': 'R', 'ꓢ': 'S', 'ꓔ': 'T', 'ꓴ': 'U',
  // stroke letters (no decomposition, so NFD does not strip the stroke)
  'Ŧ': 'T', 'ŧ': 't', 'Đ': 'D', 'đ': 'd',
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", lpar: '(', rpar: ')', lsqb: '[', rsqb: ']',
  lbrack: '[', rbrack: ']', equals: '=', sol: '/', colon: ':', lowbar: '_', hyphen: '-', nbsp: ' ',
};

/** Invisible to a person: format chars (incl. tag chars), combining marks, CGJ, variation selectors. */
const INVISIBLE = /[\p{Cf}\p{M}\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

type Reading = 'person' | 'tokenizer' | 'tag-decoding';

function read(text: string, reading: Reading): string {
  const decoded = text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ');
  const out: string[] = [];
  for (const c of decoded) {
    const cp = c.codePointAt(0)!;
    if (reading === 'tag-decoding' && cp >= 0xe0020 && cp <= 0xe007e) {
      out.push(String.fromCharCode(cp - 0xe0000));
      continue;
    }
    if (INVISIBLE.test(c)) {
      if (reading === 'tokenizer') out.push(' ');
      continue;
    }
    for (const n of c.normalize('NFKC').normalize('NFD')) {
      if (INVISIBLE.test(n)) continue;
      out.push(HOMOGLYPHS[n] ?? n);
    }
  }
  return out.join('').toUpperCase();
}

const READINGS: Reading[] = ['person', 'tokenizer', 'tag-decoding'];

/** Every reading of `text` (exported for diagnostics in assertion messages). */
export function modelReads(text: string): string[] {
  return READINGS.map((r) => read(text, r));
}

/** Some reader still sees "UNTRUSTED CALLER CONTENT" (letters and digits only — separators are not breaks). */
export function hasLiveFenceMarker(text: string): boolean {
  return modelReads(text).some((r) => r.replace(/[^\p{L}\p{N}]/gu, '').includes('UNTRUSTEDCALLERCONTENT'));
}

/** Some reader still sees a chat-role tag such as `<system>` / `</system>`. */
export function hasLiveRoleTag(text: string): boolean {
  return modelReads(text).some((r) => /<\s*\/?\s*(?:SYSTEM|ASSISTANT|DEVELOPER|INSTRUCTION|PROMPT|TOOL|FUNCTION)/.test(r));
}

/** Some reader still sees a closed square-bracket `[BEGIN …]` / `[END …]` delimiter on one line. */
export function hasLiveBracketMarker(text: string): boolean {
  return modelReads(text).some((r) =>
    /\[[^\p{L}\p{N}\]\n]*(?:BEGIN|END)(?![\p{L}\p{N}])[^\]\n]*\]/u.test(r),
  );
}
