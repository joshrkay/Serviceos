/**
 * #1229 review — an INDEPENDENT oracle for "what does a model read here?",
 * used to prove caller text reaching a prompt carries no live fence marker,
 * chat-role tag, or `[BEGIN …]`/`[END …]` delimiter, however it is spelled.
 *
 * Deliberately NOT built on the production neutraliser (a test that asks the
 * code under test whether it worked proves nothing). It reads text the way a
 * tokenizer-level reader does: HTML entities and JSON escapes decoded,
 * compatibility forms folded (NFKC), invisible format characters, combining
 * marks and variation selectors dropped, the Cyrillic / Greek homoglyphs the
 * tests plant folded to Latin, case ignored.
 */

/** The homoglyphs the #1229 probes plant (Cyrillic + Greek capitals / smalls that render as Latin). */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  'А': 'A', 'а': 'a', 'В': 'B', 'С': 'C', 'с': 'c', 'Е': 'E', 'е': 'e', 'Н': 'H', 'І': 'I', 'і': 'i',
  'К': 'K', 'М': 'M', 'О': 'O', 'о': 'o', 'Р': 'P', 'р': 'p', 'Ѕ': 'S', 'ѕ': 's', 'Т': 'T', 'Х': 'X', 'у': 'y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'ο': 'o',
  'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", lpar: '(', rpar: ')', lsqb: '[', rsqb: ']',
  lbrack: '[', rbrack: ']', equals: '=', sol: '/', colon: ':', lowbar: '_', hyphen: '-', nbsp: ' ',
};

/** Invisible to a reader: format chars (incl. tag chars), combining marks, CGJ, variation selectors. */
const INVISIBLE = /[\p{Cf}\p{M}͏︀-️\u{E0100}-\u{E01EF}]/u;

export function modelReads(text: string): string {
  const decoded = text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ');
  return [...decoded.normalize('NFKC').normalize('NFD')]
    .filter((c) => !INVISIBLE.test(c))
    .map((c) => HOMOGLYPHS[c] ?? c)
    .join('')
    .toUpperCase();
}

/** Letters and digits only — separators, punctuation and spacing between letters are not read as breaks. */
function alnum(text: string): string {
  return modelReads(text).replace(/[^\p{L}\p{N}]/gu, '');
}

/** A reader still sees "UNTRUSTED CALLER CONTENT" (any order of BEGIN/END around it). */
export function hasLiveFenceMarker(text: string): boolean {
  return alnum(text).includes('UNTRUSTEDCALLERCONTENT');
}

/** A reader still sees a chat-role tag such as `<system>` / `</system>`. */
export function hasLiveRoleTag(text: string): boolean {
  return /<\s*\/?\s*(?:SYSTEM|ASSISTANT|DEVELOPER|INSTRUCTION|PROMPT|TOOL|FUNCTION)/.test(modelReads(text));
}

/** A reader still sees a square-bracket `[BEGIN …]` / `[END …]` delimiter. */
export function hasLiveBracketMarker(text: string): boolean {
  return /\[[^\p{L}\p{N}\]\n]*(?:BEGIN|END)(?![\p{L}\p{N}])/u.test(modelReads(text));
}
