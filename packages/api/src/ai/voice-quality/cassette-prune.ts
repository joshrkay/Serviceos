/**
 * VQ — safety machinery for `scripts/seed-voice-quality-cassettes.ts
 * --prune`, the one tool in this repo that DELETES committed data (a single
 * healthy prune run removes tens of thousands of lines of cassette JSON).
 *
 * Extracted here rather than left inline in the script for two reasons: the
 * script's own import graph pulls the whole corpus loader + runner + driver
 * factory, so unit-testing it in place would be needlessly heavy; and this
 * is the part whose failure modes actually matter, so it deserves its own
 * suite (test/voice-quality/cassette-prune.test.ts). Sibling of
 * `cassette-staleness.ts`, which owns the per-entry decision
 * (`pruneEntriesBefore`); this module owns everything AROUND that decision:
 * did the authoritative refresh really run, what would change, and is any
 * of it obviously wrong?
 *
 * ── WHAT WENT WRONG BEFORE THIS EXISTED (review follow-up K2, 2026-08-09) ─
 *
 * The first `--prune` implementation could delete every entry in every
 * cassette and exit 0 with a success line. Three independent holes, each
 * sufficient on its own:
 *
 *   1. It trusted the refresh subprocess's EXIT CODE.
 *      `vitest.voice-quality.config.ts` sets `passWithNoTests: true`, so
 *      `vitest run -c vitest.voice-quality.config.ts <nonexistent file>`
 *      exits 0. `execFileSync` only throws on a non-zero exit. So any
 *      include-glob drift — an entry file renamed, moved, or re-globbed —
 *      reads as "refresh succeeded" while nothing ran, after which every
 *      entry is pre-cutoff, `pruneEntriesBefore` returns "prune
 *      everything", and all 73 cassettes are written empty.
 *      -> `assertRefreshCovered` asserts the run POSITIVELY: the report the
 *         config already emits must exist, postdate the cutoff, and contain
 *         a passing result for every expected script id.
 *
 *   2. No `kept.length` guard. This one ALREADY FIRED, in commit 0b60e9d5c:
 *      `es-emergency-escalation` legitimately issues zero LLM calls, so its
 *      27 accreted entries were all pre-cutoff and it was written to
 *      `entries: []` — turning the documented pre-launch gate
 *      `voice-quality:check-cassettes` red. The log line for an emptied
 *      cassette was byte-indistinguishable from a healthy prune.
 *      -> `planCassettePrune` REFUSES to empty a cassette that had entries,
 *         naming every offender, unless `--allow-emptying` is passed.
 *
 *   3. Incremental writes with no containment: unguarded `JSON.parse`, a
 *      bare `as CassetteFile` cast, and a write per file inside the loop. A
 *      malformed cassette at file 40 of 73 threw after 39 files had already
 *      been rewritten, with no rollback and no record of which.
 *      -> plan/apply split: `planCassettePrune` reads and validates EVERY
 *         file and writes nothing; `applyCassettePrune` writes only after a
 *         complete, valid plan exists. Each planned file carries its
 *         `previousContent` so the caller can roll the whole batch back.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pruneEntriesBefore } from './cassette-staleness';
import type { CassetteEntry } from './cassette-gateway';

/** Parsed argv for `scripts/seed-voice-quality-cassettes.ts`. */
export interface SeedCassetteArgs {
  mode: 'seed' | 'prune';
  /** Evaluate and report, but perform no prune writes. */
  dryRun: boolean;
  /** Explicit opt-in to write an empty `entries` array over a non-empty one. */
  allowEmptying: boolean;
}

const KNOWN_FLAGS = ['--prune', '--dry-run', '--allow-emptying'] as const;

/**
 * Strict argv parser (review follow-up K2f). The previous
 * `argv.includes('--prune')` check meant `--Prune`, `--prune-corpus` and
 * `--dry-run` all fell silently through to `seed()`, running RECORD mode
 * across 73 corpus scripts when the operator asked for a prune. An unknown
 * argument is now a hard error naming the flags that exist.
 */
export function parseSeedCassetteArgs(argv: string[]): SeedCassetteArgs {
  for (const arg of argv) {
    if (!(KNOWN_FLAGS as readonly string[]).includes(arg)) {
      throw new Error(
        `seed-voice-quality-cassettes: unknown argument ${JSON.stringify(arg)}. ` +
          `Known flags: ${KNOWN_FLAGS.join(', ')}.`,
      );
    }
  }
  const mode = argv.includes('--prune') ? 'prune' : 'seed';
  const dryRun = argv.includes('--dry-run');
  const allowEmptying = argv.includes('--allow-emptying');
  if (mode === 'seed' && (dryRun || allowEmptying)) {
    throw new Error(
      'seed-voice-quality-cassettes: --dry-run and --allow-emptying only apply to --prune.',
    );
  }
  return { mode, dryRun, allowEmptying };
}

export interface CassettePruneCandidate {
  scriptId: string;
  file: string;
}

export interface PlannedCassetteWrite {
  scriptId: string;
  file: string;
  keptCount: number;
  prunedCount: number;
  /** Exact bytes currently on disk — the rollback source. */
  previousContent: string;
  /** Exact bytes to write. */
  nextContent: string;
}

export interface CassettePrunePlan {
  /** Only files that would actually change. */
  files: PlannedCassetteWrite[];
  /** How many cassette files were read and validated. */
  evaluated: number;
  totalPruned: number;
}

interface ParsedCassette {
  scriptId?: unknown;
  entries?: unknown;
  [k: string]: unknown;
}

/**
 * Read, validate and evaluate every candidate cassette. Writes NOTHING.
 *
 * Throws — before any file is touched — when a cassette is unreadable, is
 * not JSON, has a non-array `entries`, or would be emptied without
 * `allowEmptying`. Every emptying offender is reported, not just the first,
 * so one run tells the operator the whole story.
 */
export function planCassettePrune(
  candidates: CassettePruneCandidate[],
  cutoffIso: string,
  opts: { allowEmptying: boolean },
): CassettePrunePlan {
  const files: PlannedCassetteWrite[] = [];
  const wouldEmpty: string[] = [];
  let evaluated = 0;
  let totalPruned = 0;

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(candidate.file, 'utf-8');
    } catch (err) {
      throw new Error(`Cannot read cassette ${candidate.file}: ${errText(err)}`);
    }

    let parsed: ParsedCassette;
    try {
      parsed = JSON.parse(raw) as ParsedCassette;
    } catch (err) {
      throw new Error(`Cassette ${candidate.file} is not valid JSON: ${errText(err)}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`Cassette ${candidate.file} is not a JSON object.`);
    }
    if (!Array.isArray(parsed.entries)) {
      throw new Error(
        `Cassette ${candidate.file} has no "entries" array (found ${typeof parsed.entries}).`,
      );
    }
    evaluated++;

    const before = parsed.entries as CassetteEntry[];
    const { kept, pruned } = pruneEntriesBefore(before, cutoffIso);
    if (pruned.length === 0) continue;
    if (kept.length === 0 && before.length > 0) {
      wouldEmpty.push(candidate.scriptId);
      if (!opts.allowEmptying) continue;
    }

    files.push({
      scriptId: candidate.scriptId,
      file: candidate.file,
      keptCount: kept.length,
      prunedCount: pruned.length,
      previousContent: raw,
      // Same serialization CassetteLLMGateway.writeCassette uses (no
      // trailing newline) — keeps a --prune diff limited to the removed
      // entries, not a gratuitous formatting change.
      nextContent: JSON.stringify({ ...parsed, entries: kept }, null, 2),
    });
    totalPruned += pruned.length;
  }

  if (wouldEmpty.length > 0 && !opts.allowEmptying) {
    throw new Error(
      `Refusing to prune: ${wouldEmpty.length} cassette(s) would be left with ZERO entries:\n` +
        wouldEmpty.map((id) => `  - ${id}`).join('\n') +
        '\n\nAn emptied cassette fails `npm run voice-quality:check-cassettes` (a documented ' +
        'pre-launch gate). Either the refresh did not reproduce those calls — investigate ' +
        'first — or the script genuinely issues zero LLM calls, in which case DELETE its ' +
        'cassette file rather than committing an empty one. Pass --allow-emptying to proceed ' +
        'anyway.',
    );
  }

  return { files, evaluated, totalPruned };
}

/** Write a fully-formed plan. Never call this without a plan from `planCassettePrune`. */
export function applyCassettePrune(plan: CassettePrunePlan): void {
  for (const f of plan.files) {
    fs.writeFileSync(f.file, f.nextContent, 'utf-8');
  }
}

/** Restore every file a plan wrote to its pre-prune bytes. */
export function rollbackCassettePrune(plan: CassettePrunePlan): void {
  for (const f of plan.files) {
    fs.writeFileSync(f.file, f.previousContent, 'utf-8');
  }
}

interface VitestAssertion {
  title?: unknown;
  fullName?: unknown;
  status?: unknown;
}

interface VitestJsonReport {
  startTime?: unknown;
  testResults?: { assertionResults?: VitestAssertion[] }[];
}

/**
 * Positively assert that the authoritative refresh pass really executed the
 * expected corpus scripts (K2b). Exit code alone proves nothing here:
 * `passWithNoTests: true` makes a run that matched no test files exit 0.
 *
 * The corpus config already emits this report (`outputFile.json`), and the
 * runner names each test `VQ-CORPUS — <bucket> — <scriptId>`, so the script
 * id is recoverable from the title. Four things must hold: the report
 * exists and parses; it POSTDATES the cutoff (a leftover report from an
 * earlier run would otherwise satisfy everything else); every expected
 * script id appears; and each of those passed.
 */
export function assertRefreshCovered(
  reportPath: string,
  expectedScriptIds: string[],
  cutoffIso: string,
): void {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) {
    throw new Error(`assertRefreshCovered: cutoff is not a parseable timestamp (${cutoffIso}).`);
  }
  if (!fs.existsSync(reportPath)) {
    throw new Error(
      `Refresh report not found at ${reportPath}. The refresh subprocess exited 0 but produced ` +
        'no report, which is exactly what an include-glob miss looks like (passWithNoTests: ' +
        'true). Refusing to prune.',
    );
  }
  let report: VitestJsonReport;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as VitestJsonReport;
  } catch (err) {
    throw new Error(`Refresh report at ${reportPath} is unreadable/not JSON: ${errText(err)}`);
  }

  const startTime = typeof report.startTime === 'number' ? report.startTime : NaN;
  if (!Number.isFinite(startTime) || startTime < cutoffMs) {
    throw new Error(
      `Refresh report at ${reportPath} is stale: it started ` +
        `${Number.isFinite(startTime) ? new Date(startTime).toISOString() : '<unknown>'}, ` +
        `before the cutoff ${cutoffIso}. That report describes an EARLIER run, not the refresh ` +
        'just requested. Refusing to prune.',
    );
  }

  const passed = new Set<string>();
  const seen = new Set<string>();
  for (const suite of report.testResults ?? []) {
    for (const a of suite.assertionResults ?? []) {
      const title = typeof a.title === 'string' ? a.title : typeof a.fullName === 'string' ? a.fullName : '';
      const scriptId = scriptIdFromTitle(title);
      if (!scriptId) continue;
      seen.add(scriptId);
      if (a.status === 'passed') passed.add(scriptId);
    }
  }

  const missing = expectedScriptIds.filter((id) => !seen.has(id));
  const failed = expectedScriptIds.filter((id) => seen.has(id) && !passed.has(id));
  if (missing.length > 0 || failed.length > 0) {
    throw new Error(
      'Refresh did not reproduce the full corpus — refusing to prune.\n' +
        (missing.length > 0 ? `  did not run (${missing.length}): ${missing.join(', ')}\n` : '') +
        (failed.length > 0 ? `  ran but failed (${failed.length}): ${failed.join(', ')}\n` : '') +
        'Pruning against an incomplete refresh deletes entries that are still live.',
    );
  }
}

/** `VQ-CORPUS — 11-spanish — es-emergency-escalation` -> `es-emergency-escalation`. */
function scriptIdFromTitle(title: string): string | null {
  if (!title.includes('VQ-CORPUS')) return null;
  const parts = title.split('—').map((p) => p.trim());
  const last = parts[parts.length - 1];
  return last && last !== 'VQ-CORPUS' ? last : null;
}

/** Convenience for the script: cassette files for a list of script ids. */
export function cassetteCandidates(cassettesDir: string, scriptIds: string[]): CassettePruneCandidate[] {
  return scriptIds.map((scriptId) => ({
    scriptId,
    file: path.join(cassettesDir, `${scriptId}.json`),
  }));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
