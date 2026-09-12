/**
 * Shared source-tree scanner for the §5 structural invariant guards
 * (#1021 — I1′, I5′, I6, I8′, I9′, I13′, I15).
 *
 * Every guard built on this helper follows the `ai/gateway-ci-guard.test.ts`
 * (I15) shape and earns rung 4 the same way: it is a PURE function of a set
 * of root directories, so the same guard that scans `packages/api/src` can be
 * pointed at a temp directory holding a PLANTED violation. A guard that
 * cannot be shown failing has proved nothing — the negative control is the
 * evidence, not the green run.
 *
 * Two rules this module exists to enforce on the guards themselves:
 *
 *   1. **Comments are not code.** This repo's `src` is unusually
 *      comment-dense and the doc comments quote the very patterns the guards
 *      look for (`missingFields: ['invoiceId']`, `new OpenAI(`,
 *      `totalCents = subtotal + tax`). A guard that matched comment text
 *      would be measuring prose. `stripComments` blanks comment bodies while
 *      preserving byte offsets, so line/column numbers in a violation still
 *      point at the real line.
 *
 *   2. **An exception is a named list, never a loosened regex.** Guards take
 *      their allowed exceptions as explicit `{ file, why }` records so the
 *      hole is visible in review and in the lane report.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SourceFile {
  /** Absolute path on disk. */
  readonly path: string;
  /** Path relative to the scan root it was found under (stable in output). */
  readonly rel: string;
  /** Raw file text. */
  readonly text: string;
  /** File text with every comment body blanked, byte offsets preserved. */
  readonly code: string;
}

export interface Violation {
  /** `<rel>:<line>` — the citation a report can paste verbatim. */
  readonly at: string;
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
]);

/**
 * Blank out `//` line comments and `/* *\/` block comments, replacing each
 * comment character with a space so every subsequent character keeps its
 * original offset and every line keeps its original number.
 *
 * Deliberately a small state machine rather than a regex: a regex cannot tell
 * `'https://x'` (a string that contains `//`) from a comment, and this repo
 * has plenty of both. String and template literals are tracked so their
 * contents survive; a regex literal is NOT tracked (a `/` in an expression
 * position is rare here and the failure mode is a blanked expression, never a
 * false violation).
 */
export function stripComments(text: string): string {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

  while (i < n) {
    const c = text[i];
    const next = i + 1 < n ? text[i + 1] : '';

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        i += 1;
        continue;
      }
      out[i] = ' ';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 2;
        continue;
      }
      if (c !== '\n') out[i] = ' ';
      i += 1;
      continue;
    }

    // Inside a string/template literal: honour escapes, then look for the close.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }

  return out.join('');
}

export interface ListOptions {
  /** File extensions to include. Default: `.ts` (not `.d.ts`). */
  readonly extensions?: readonly string[];
  /** Relative paths (or path prefixes) to skip entirely. */
  readonly skipRelPrefixes?: readonly string[];
}

/** Every source file under `roots`, comment-stripped and ready to scan. */
export function listSourceFiles(
  roots: readonly string[],
  opts: ListOptions = {},
): SourceFile[] {
  const extensions = opts.extensions ?? ['.ts'];
  const skips = opts.skipRelPrefixes ?? [];
  const files: SourceFile[] = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, root);
  }

  function walk(dir: string, root: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(entry.name)) continue;
        walk(abs, root);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      const rel = toPosix(path.relative(path.dirname(root), abs));
      if (skips.some((prefix) => rel.startsWith(prefix))) continue;
      const text = fs.readFileSync(abs, 'utf8');
      files.push({ path: abs, rel, text, code: stripComments(text) });
    }
  }

  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Windows-proof relative paths so citations are stable in the report. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Every line of `file.code` matching `pattern`, as citable violations.
 *
 * `pattern` is applied per line with the `g` flag stripped, so a caller
 * cannot accidentally carry `lastIndex` between lines.
 */
export function matchLines(file: SourceFile, pattern: RegExp): Violation[] {
  const rx = new RegExp(pattern.source, pattern.flags.replace(/g/g, ''));
  const codeLines = file.code.split('\n');
  const textLines = file.text.split('\n');
  const found: Violation[] = [];
  for (let i = 0; i < codeLines.length; i += 1) {
    if (!rx.test(codeLines[i])) continue;
    found.push({
      at: `${file.rel}:${i + 1}`,
      file: file.rel,
      line: i + 1,
      snippet: (textLines[i] ?? '').trim(),
    });
  }
  return found;
}

/** Scan every file under `roots` for `pattern`, skipping exempt files. */
export function scanForPattern(
  roots: readonly string[],
  pattern: RegExp,
  opts: ListOptions & { readonly exemptRel?: (rel: string) => boolean } = {},
): Violation[] {
  const exempt = opts.exemptRel ?? (() => false);
  return listSourceFiles(roots, opts)
    .filter((f) => !exempt(f.rel))
    .flatMap((f) => matchLines(f, pattern));
}

/** Format violations for an assertion message / the lane report. */
export function formatViolations(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.at}  ${v.snippet}`);
}

/**
 * Write `contents` into a fresh temp directory and return that directory.
 *
 * This is the negative control's plant site. A temp directory rather than a
 * real file under `src` on purpose: the guard under test takes its roots as
 * an argument, so pointing it at a planted tree proves it detects the
 * violation without the test ever mutating the repository it is guarding.
 */
export function plantTree(
  prefix: string,
  contents: Readonly<Record<string, string>>,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  for (const [rel, body] of Object.entries(contents)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

/** Remove a planted tree. Safe to call twice. */
export function removeTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Absolute path to `packages/api/src`. */
export const API_SRC = path.resolve(__dirname, '../../src');
