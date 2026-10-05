/**
 * Shared source scanner for the spoken-copy structural guards.
 *
 * Born in #1599 (`text-mode-driver.structural.test.ts`: the Layer 1 driver
 * speaks nothing of its own) and shared from #1601 step 1 with the guard that
 * keeps every voice file's spoken copy in `tts-copy.ts`. A "sentence" is any
 * string literal of three or more words carrying sentence punctuation — ids,
 * event names and prefixes are one or two tokens and never end in a period.
 *
 * Comments are blanked by a small state machine that knows it is inside a
 * string, so a `//` or `/*` INSIDE a literal ("see docs // then speak") does
 * not truncate it and desync the rest of the line. Regex literals are not
 * recognised (a quote inside `/'/g` can still open a phantom string); the
 * guarded files are probed clean of that today.
 *
 * Template literals are scanned with their `${…}` expressions blanked first,
 * so a template made only of expressions (`${opener} ${cta}`) is not read as
 * copy while `Thank you for calling ${business}. How can I help?` still is.
 */

/**
 * Blank block + line comments (keeping newlines so line numbers hold) without
 * touching comment-like sequences inside string or template literals.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      // Copy the whole literal through, honouring backslash escapes.
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        if (ch !== '`' && source[j] === '\n') break; // unterminated plain string: stop at EOL
        j += 1;
      }
      const stop = Math.min(j + 1, n);
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
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
