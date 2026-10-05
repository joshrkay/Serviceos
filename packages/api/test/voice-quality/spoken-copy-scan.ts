/**
 * Shared source scanner for the spoken-copy structural guards.
 *
 * Born in #1599 (`text-mode-driver.structural.test.ts`: the Layer 1 driver
 * speaks nothing of its own) and shared from #1601 step 1 with the guard that
 * keeps every voice file's spoken copy in `tts-copy.ts`. A "sentence" is any
 * string literal of three or more words carrying sentence punctuation — ids,
 * event names and prefixes are one or two tokens and never end in a period.
 *
 * Template literals are scanned with their `${…}` expressions blanked first,
 * so a template made only of expressions (`${opener} ${cta}`) is not read as
 * copy while `Thank you for calling ${business}. How can I help?` still is.
 */

/** Strip block + line comments so documentation prose is not read as copy. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

export interface SourceLiteral {
  /** The raw text between the quotes, escapes preserved (what the file says). */
  raw: string;
  /** True for a backtick template literal. */
  template: boolean;
}

/** Every string literal (single, double, template) in comment-free source. */
export function sourceLiterals(code: string): SourceLiteral[] {
  const out: SourceLiteral[] = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    out.push({ raw: m[1] ?? m[2] ?? m[3] ?? '', template: m[3] !== undefined });
  }
  return out;
}

/** Every string literal's raw text (the #1599 shape). */
export function stringLiterals(code: string): string[] {
  return sourceLiterals(code).map((l) => l.raw);
}

/** A caller-facing sentence: three or more words and sentence punctuation. */
export function isSpokenCopy(literal: string): boolean {
  const words = literal.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length >= 3 && /[.?!—¿¡]/.test(literal);
}

/**
 * The sentence literals of a source file, judged with `${…}` expressions
 * blanked so a template of pure expressions is not a sentence. Returns the raw
 * literal text (escapes preserved) so an allowlist can name it exactly.
 */
export function sentenceLiterals(source: string): string[] {
  return sourceLiterals(stripComments(source))
    .filter((l) => isSpokenCopy(l.template ? l.raw.replace(/\$\{[^}]*\}/g, ' ') : l.raw))
    .map((l) => l.raw);
}
