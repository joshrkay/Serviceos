/**
 * Review follow-up K2 (2026-08-09) — safety contract for the `--prune`
 * pipeline behind `scripts/seed-voice-quality-cassettes.ts`.
 *
 * The shipped version of that script could delete every entry in every
 * cassette and report success:
 *
 *   - `vitest.voice-quality.config.ts` sets `passWithNoTests: true`, so a
 *     run whose include-glob matches nothing EXITS 0. `execFileSync` only
 *     throws on a non-zero exit, so include-glob drift (an entry file
 *     renamed, moved, or re-globbed) meant "refresh succeeded" while no
 *     script ran at all — after which every entry is pre-cutoff and the
 *     prune writes `entries: []` to all 73 files and prints
 *     "Pruned 1285 superseded entries across 73 cassette(s)." with exit 0.
 *   - No `kept.length` guard. This ALREADY FIRED in 0b60e9d5c (that is how
 *     es-emergency-escalation.json reached zero entries and turned a green
 *     pre-launch gate red), and the log line for an emptied cassette was
 *     indistinguishable from a healthy prune.
 *   - Writes were incremental with no containment: a malformed cassette at
 *     file 40 of 73 threw AFTER 39 files had already been rewritten, with no
 *     rollback and no way to tell which.
 *
 * These tests pin the replacements: a plan/apply split that writes nothing
 * until every file has been evaluated, a positive assertion that the
 * refresh really executed the expected scripts, a refusal to empty a
 * cassette that had entries, and an argv parser that rejects typos instead
 * of silently running record-mode across 73 scripts.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CassetteEntry } from '../../src/ai/voice-quality/cassette-gateway';
import {
  applyCassettePrune,
  assertRefreshCovered,
  parseSeedCassetteArgs,
  planCassettePrune,
} from '../../src/ai/voice-quality/cassette-prune';

const CUTOFF = '2026-06-20T00:00:00.000Z';
const STALE = '2026-06-19T00:00:00.000Z';
const FRESH = '2026-06-21T00:00:00.000Z';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cassette-prune-'));
  tempRoots.push(root);
  return root;
}

function entry(recordedAt: string, hash = `sha256:${recordedAt}`): CassetteEntry {
  return {
    requestHash: hash,
    request: { model: '(default)', prompt: '[]', schema: 'x' },
    response: { content: '{}' } as CassetteEntry['response'],
    tokenUsage: { inputTokens: 0, outputTokens: 0, costCents: 0 },
    recordedAt,
  };
}

function writeCassette(dir: string, scriptId: string, entries: unknown, extra?: object): string {
  const file = path.join(dir, `${scriptId}.json`);
  writeFileSync(file, JSON.stringify({ scriptId, version: 1, rubricVersion: 'v1', entries, ...extra }, null, 2));
  return file;
}

function candidates(dir: string, ids: string[]): { scriptId: string; file: string }[] {
  return ids.map((scriptId) => ({ scriptId, file: path.join(dir, `${scriptId}.json`) }));
}

describe('parseSeedCassetteArgs', () => {
  it('defaults to seed mode with no arguments', () => {
    expect(parseSeedCassetteArgs([])).toEqual({ mode: 'seed', dryRun: false, allowEmptying: false });
  });

  it('recognizes --prune, --dry-run and --allow-emptying', () => {
    expect(parseSeedCassetteArgs(['--prune', '--dry-run'])).toEqual({
      mode: 'prune',
      dryRun: true,
      allowEmptying: false,
    });
    expect(parseSeedCassetteArgs(['--prune', '--allow-emptying'])).toEqual({
      mode: 'prune',
      dryRun: false,
      allowEmptying: true,
    });
  });

  // (f) — every one of these used to fall straight through to `seed()`,
  // silently running RECORD mode across all 73 corpus scripts when the
  // operator asked for a prune.
  it.each(['--Prune', '--prune-corpus', '--prune=true', '-p', 'prune'])(
    'rejects the unknown argument %s instead of silently running record mode',
    (arg) => {
      expect(() => parseSeedCassetteArgs([arg])).toThrow(/unknown argument/i);
    },
  );

  it('rejects --dry-run without --prune (there is nothing to dry-run in seed mode)', () => {
    expect(() => parseSeedCassetteArgs(['--dry-run'])).toThrow(/--prune/);
  });
});

describe('planCassettePrune', () => {
  it('plans the stale entries away and leaves the fresh ones', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1'), entry(FRESH, 'h2')]);

    const plan = planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: false });

    expect(plan.totalPruned).toBe(1);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].keptCount).toBe(1);
    expect(plan.files[0].prunedCount).toBe(1);
  });

  it('writes nothing by itself — planning is pure', () => {
    const dir = makeDir();
    const file = writeCassette(dir, 'a', [entry(STALE, 'h1'), entry(FRESH, 'h2')]);
    const before = readFileSync(file, 'utf-8');

    planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: false });

    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('skips a cassette file that does not exist', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1')]);

    const plan = planCassettePrune(candidates(dir, ['a', 'missing']), CUTOFF, { allowEmptying: true });

    expect(plan.files.map((f) => f.scriptId)).toEqual(['a']);
  });

  // (c) — the guard that would have caught K1 before it landed.
  it('refuses to empty a cassette that had entries, naming the script id', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(FRESH, 'h1')]);
    writeCassette(dir, 'es-emergency-escalation', [entry(STALE, 'h2'), entry(STALE, 'h3')]);

    expect(() =>
      planCassettePrune(candidates(dir, ['a', 'es-emergency-escalation']), CUTOFF, {
        allowEmptying: false,
      }),
    ).toThrow(/es-emergency-escalation/);
  });

  it('names the opt-in flag in the refusal so the operator knows the escape hatch', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1')]);

    expect(() => planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: false })).toThrow(
      /--allow-emptying/,
    );
  });

  it('permits emptying only under the explicit opt-in', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1')]);

    const plan = planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: true });
    expect(plan.files[0].keptCount).toBe(0);
  });

  it('reports EVERY cassette that would be emptied, not just the first', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1')]);
    writeCassette(dir, 'b', [entry(STALE, 'h2')]);

    expect(() =>
      planCassettePrune(candidates(dir, ['a', 'b']), CUTOFF, { allowEmptying: false }),
    ).toThrow(/a[\s\S]*b/);
  });

  // (e) + (a) — a malformed file must fail the WHOLE plan before any write,
  // not part-way through a 73-file rewrite.
  it('throws on malformed JSON, naming the file, without planning any writes', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(STALE, 'h1'), entry(FRESH, 'h2')]);
    writeFileSync(path.join(dir, 'b.json'), '{ not json');

    expect(() => planCassettePrune(candidates(dir, ['a', 'b']), CUTOFF, { allowEmptying: true })).toThrow(
      /b\.json/,
    );
  });

  it('throws when entries is not an array', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', { nope: true });

    expect(() => planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: true })).toThrow(
      /entries/i,
    );
  });

  it('propagates the unparseable-cutoff refusal rather than pruning everything', () => {
    const dir = makeDir();
    writeCassette(dir, 'a', [entry(FRESH, 'h1')]);

    expect(() => planCassettePrune(candidates(dir, ['a']), 'not-a-date', { allowEmptying: true })).toThrow(
      /cutoff/i,
    );
  });
});

describe('applyCassettePrune', () => {
  it('writes exactly the planned cassettes and preserves the surviving entries', () => {
    const dir = makeDir();
    const file = writeCassette(dir, 'a', [entry(STALE, 'h1'), entry(FRESH, 'h2')]);

    const plan = planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: false });
    applyCassettePrune(plan);

    const after = JSON.parse(readFileSync(file, 'utf-8')) as { entries: CassetteEntry[]; scriptId: string };
    expect(after.scriptId).toBe('a');
    expect(after.entries.map((e) => e.requestHash)).toEqual(['h2']);
  });

  it('can be rolled back to the exact pre-prune bytes', () => {
    const dir = makeDir();
    const file = writeCassette(dir, 'a', [entry(STALE, 'h1'), entry(FRESH, 'h2')]);
    const before = readFileSync(file, 'utf-8');

    const plan = planCassettePrune(candidates(dir, ['a']), CUTOFF, { allowEmptying: false });
    applyCassettePrune(plan);
    expect(readFileSync(file, 'utf-8')).not.toBe(before);

    for (const f of plan.files) writeFileSync(f.file, f.previousContent, 'utf-8');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('assertRefreshCovered', () => {
  const CUTOFF_MS = Date.parse(CUTOFF);

  function writeReport(dir: string, body: unknown): string {
    const file = path.join(dir, 'voice-quality-vitest.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
    return file;
  }

  function report(ids: string[], over: Record<string, unknown> = {}): unknown {
    return {
      numTotalTests: ids.length,
      numPassedTests: ids.length,
      numFailedTests: 0,
      success: true,
      startTime: CUTOFF_MS + 1000,
      testResults: [
        {
          assertionResults: ids.map((id) => ({
            title: `VQ-CORPUS — bucket — ${id}`,
            fullName: `Voice Quality v1 (Layer 1) — corpus VQ-CORPUS — bucket — ${id}`,
            status: 'passed',
          })),
        },
      ],
      ...over,
    };
  }

  it('accepts a complete, passing, post-cutoff report', () => {
    const dir = makeDir();
    const file = writeReport(dir, report(['a', 'b']));
    expect(() => assertRefreshCovered(file, ['a', 'b'], CUTOFF)).not.toThrow();
  });

  // (b) — the hole that makes every other guard moot. `passWithNoTests: true`
  // means a run that matched no test files exits 0.
  it('throws when the report is missing entirely (the run never wrote one)', () => {
    const dir = makeDir();
    expect(() => assertRefreshCovered(path.join(dir, 'nope.json'), ['a'], CUTOFF)).toThrow(
      /report/i,
    );
  });

  it('throws when the run executed zero tests despite exiting 0', () => {
    const dir = makeDir();
    const file = writeReport(dir, report([]));
    expect(() => assertRefreshCovered(file, ['a', 'b'], CUTOFF)).toThrow(/a, b|did not run/i);
  });

  it('throws when an expected script is absent from the report', () => {
    const dir = makeDir();
    const file = writeReport(dir, report(['a']));
    expect(() => assertRefreshCovered(file, ['a', 'b'], CUTOFF)).toThrow(/b/);
  });

  it('throws when an expected script ran but FAILED', () => {
    const dir = makeDir();
    const body = report(['a', 'b']) as {
      testResults: { assertionResults: { status: string }[] }[];
      numFailedTests: number;
    };
    body.testResults[0].assertionResults[1].status = 'failed';
    body.numFailedTests = 1;
    const file = writeReport(dir, body);
    expect(() => assertRefreshCovered(file, ['a', 'b'], CUTOFF)).toThrow(/b/);
  });

  // A leftover report from an earlier run would otherwise satisfy every
  // other check while the run we care about did nothing.
  it('throws when the report predates the cutoff (a stale report from an earlier run)', () => {
    const dir = makeDir();
    const file = writeReport(dir, report(['a', 'b'], { startTime: CUTOFF_MS - 60_000 }));
    expect(() => assertRefreshCovered(file, ['a', 'b'], CUTOFF)).toThrow(/stale|before the cutoff/i);
  });

  it('throws on a malformed report rather than treating it as a pass', () => {
    const dir = makeDir();
    const file = path.join(dir, 'voice-quality-vitest.json');
    writeFileSync(file, '{ not json');
    expect(() => assertRefreshCovered(file, ['a'], CUTOFF)).toThrow(/report/i);
  });
});
