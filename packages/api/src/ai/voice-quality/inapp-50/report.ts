/**
 * Run artifact + console scoreboard for the in-app 50-case register.
 *
 * Schema: `inapp-50-run-v1` (docs/plans/2026-09-09-inapp-50-cases-plan.md).
 * `latest.json` is the newest FULL run; a batch run (`--batch N`) writes its
 * own file and merges into `latest.json` BY CASE KEY, so five 10-case batches
 * add up to one 50-case picture without any of them clobbering the other four.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Register } from './register';
import type { CaseResult } from './runner';
import type { RootCauseCategory, Verdict } from './score';

export const RUN_VERSION = 'inapp-50-run-v1';

/** docs/verification-runs/inapp-50 — resolved from this module, repo-rooted. */
export const RUN_DIR = resolve(
  __dirname,
  '../../../../../../docs/verification-runs/inapp-50',
);

const VERDICTS: Verdict[] = ['PASS', 'PARTIAL', 'DEGRADED', 'FAIL'];
const ROOT_CAUSES: RootCauseCategory[] = [
  'intent',
  'slot_capture',
  'proposal_generation',
  'fallback',
  'infra',
];

export type VerdictTally = Record<Verdict, number>;

export interface RunSummary {
  total: number;
  PASS: number;
  PARTIAL: number;
  DEGRADED: number;
  FAIL: number;
  bySeverity: Record<string, VerdictTally>;
  byCluster: Record<string, VerdictTally>;
  byRootCause: Record<RootCauseCategory, number>;
  /** Critical scheduling/search/confirmation cases that produced nothing. */
  intentCaptureOnlyCritical: string[];
  gate: { pass: boolean; reasons: string[] };
}

export interface RunResult {
  version: typeof RUN_VERSION;
  runId: string;
  mode: 'hermetic';
  registerVersion: string;
  gitSha: string;
  startedAt: string;
  finishedAt: string;
  batch: { index: number; size: number } | null;
  summary: RunSummary;
  cases: CaseResult[];
}

/** Clusters whose critical cases MUST end in a proposal or an answer. */
export const GATED_CLUSTERS = new Set(['scheduling', 'search', 'confirmations']);

function emptyTally(): VerdictTally {
  return { PASS: 0, PARTIAL: 0, DEGRADED: 0, FAIL: 0 };
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: RUN_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** `2026-09-09T14:05:00.000Z` → `2026-09-09T14-05-00-000Z` (filename-safe). */
export function runIdFrom(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export interface BuildRunResultOptions {
  startedAt: Date;
  finishedAt: Date;
  batch: { index: number; size: number } | null;
}

export function buildRunResult(
  register: Register,
  cases: readonly CaseResult[],
  options: BuildRunResultOptions,
): RunResult {
  return {
    version: RUN_VERSION,
    runId: runIdFrom(options.startedAt),
    mode: 'hermetic',
    registerVersion: register.version,
    gitSha: gitSha(),
    startedAt: options.startedAt.toISOString(),
    finishedAt: options.finishedAt.toISOString(),
    batch: options.batch,
    summary: summarize(register, cases),
    cases: [...cases],
  };
}

/**
 * Summary + gate. The three release rules, verbatim from the plan:
 *   1. every case PASSes,
 *   2. no critical scheduling/search/confirmation case ends `intent_capture_only`,
 *   3. no FAIL verdicts at any severity.
 */
export function summarize(register: Register, cases: readonly CaseResult[]): RunSummary {
  const summary: RunSummary = {
    total: cases.length,
    PASS: 0,
    PARTIAL: 0,
    DEGRADED: 0,
    FAIL: 0,
    bySeverity: { critical: emptyTally(), core: emptyTally(), growth: emptyTally() },
    byCluster: Object.fromEntries(register.clusters.map((c) => [c, emptyTally()])),
    byRootCause: Object.fromEntries(ROOT_CAUSES.map((r) => [r, 0])) as Record<
      RootCauseCategory,
      number
    >,
    intentCaptureOnlyCritical: [],
    gate: { pass: false, reasons: [] },
  };

  for (const c of cases) {
    summary[c.verdict] += 1;
    (summary.bySeverity[c.severity] ??= emptyTally())[c.verdict] += 1;
    (summary.byCluster[c.cluster] ??= emptyTally())[c.verdict] += 1;
    if (c.rootCause) summary.byRootCause[c.rootCause.category] += 1;
    if (c.severity === 'critical' && GATED_CLUSTERS.has(c.cluster) && c.intentCaptureOnly) {
      summary.intentCaptureOnlyCritical.push(c.key);
    }
  }

  const reasons: string[] = [];
  const expected = register.cases.length;
  if (summary.PASS !== expected) reasons.push(`PASS ${summary.PASS}/${expected}`);
  if (summary.intentCaptureOnlyCritical.length > 0) {
    reasons.push(`critical intent_capture_only: ${summary.intentCaptureOnlyCritical.join(', ')}`);
  }
  if (summary.FAIL > 0) {
    reasons.push(
      `FAIL verdicts: ${cases.filter((c) => c.verdict === 'FAIL').map((c) => c.key).join(', ')}`,
    );
  }
  summary.gate = { pass: reasons.length === 0, reasons };
  return summary;
}

// ── Artifacts ───────────────────────────────────────────────────────────────

export interface WriteResult {
  runPath: string;
  latestPath: string;
  /** What `latest.json` now holds — the merged 50 for a batch run. */
  latest: RunResult;
}

/**
 * Persist `run-<runId>[-batch<N>].json` and refresh `latest.json`.
 * A batch run merges into the existing latest by case key rather than
 * replacing it — a 10-case run must never make the other 40 disappear.
 */
export function writeRunArtifacts(
  register: Register,
  result: RunResult,
  dir: string = RUN_DIR,
): WriteResult {
  mkdirSync(dir, { recursive: true });
  const suffix = result.batch ? `-batch${result.batch.index}` : '';
  const runPath = resolve(dir, `run-${result.runId}${suffix}.json`);
  writeFileSync(runPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const latestPath = resolve(dir, 'latest.json');
  const latest = result.batch ? mergeIntoLatest(register, result, latestPath) : result;
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  return { runPath, latestPath, latest };
}

function mergeIntoLatest(register: Register, result: RunResult, latestPath: string): RunResult {
  let previous: RunResult | undefined;
  if (existsSync(latestPath)) {
    try {
      previous = JSON.parse(readFileSync(latestPath, 'utf8')) as RunResult;
    } catch {
      previous = undefined;
    }
  }
  const byKey = new Map<string, CaseResult>();
  for (const c of previous?.cases ?? []) byKey.set(c.key, c);
  for (const c of result.cases) byKey.set(c.key, c);
  const merged = [...byKey.values()].sort((a, b) => a.id - b.id);
  return {
    ...result,
    // The merged artifact is no longer "the batch" — it is the running 50.
    batch: null,
    summary: summarize(register, merged),
    cases: merged,
  };
}

// ── Console scoreboard ──────────────────────────────────────────────────────

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

/**
 * Human-readable scoreboard: per-cluster table + every non-PASS case.
 * `registerTotal` (when known) makes a partial run announce itself instead of
 * printing "GATE: FAIL — PASS 1/50" for a deliberate one-case slice.
 */
export function formatScoreboard(result: RunResult, registerTotal?: number): string {
  const s = result.summary;
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `in-app 50 · ${result.registerVersion} · ${result.mode} · ${result.gitSha.slice(0, 8)}` +
      (result.batch ? ` · batch ${result.batch.index}` : ''),
  );
  lines.push(
    `TOTAL ${s.total}  PASS ${s.PASS}  PARTIAL ${s.PARTIAL}  DEGRADED ${s.DEGRADED}  FAIL ${s.FAIL}`,
  );
  lines.push('');
  lines.push(
    `${pad('cluster', 16)}${pad('PASS', 7)}${pad('PARTIAL', 9)}${pad('DEGRADED', 10)}${pad('FAIL', 6)}`,
  );
  lines.push('-'.repeat(48));
  for (const [cluster, tally] of Object.entries(s.byCluster)) {
    const total = VERDICTS.reduce((sum, v) => sum + tally[v], 0);
    if (total === 0) continue;
    lines.push(
      `${pad(cluster, 16)}${pad(tally.PASS, 7)}${pad(tally.PARTIAL, 9)}${pad(tally.DEGRADED, 10)}${pad(tally.FAIL, 6)}`,
    );
  }
  lines.push('-'.repeat(48));
  for (const [severity, tally] of Object.entries(s.bySeverity)) {
    const total = VERDICTS.reduce((sum, v) => sum + tally[v], 0);
    if (total === 0) continue;
    lines.push(
      `${pad(severity, 16)}${pad(tally.PASS, 7)}${pad(tally.PARTIAL, 9)}${pad(tally.DEGRADED, 10)}${pad(tally.FAIL, 6)}`,
    );
  }
  lines.push('');
  lines.push(
    `root causes: ${ROOT_CAUSES.map((r) => `${r}=${s.byRootCause[r]}`).join('  ')}`,
  );

  const nonPass = result.cases.filter((c) => c.verdict !== 'PASS');
  if (nonPass.length > 0) {
    lines.push('');
    lines.push(`non-PASS (${nonPass.length}):`);
    for (const c of nonPass) {
      lines.push(
        `  ${pad(c.key, 13)} ${pad(c.verdict, 9)} ${pad(c.stage, 20)} ` +
          `${pad(c.rootCause?.category ?? '-', 20)} ${c.rootCause?.detail ?? c.reason}`,
      );
    }
  }
  if (s.intentCaptureOnlyCritical.length > 0) {
    lines.push('');
    lines.push(`critical intent_capture_only: ${s.intentCaptureOnlyCritical.join(', ')}`);
  }
  lines.push('');
  if (registerTotal !== undefined && s.total !== registerTotal) {
    const clean = nonPass.length === 0;
    lines.push(
      `SCOPE: ${s.total} of ${registerTotal} cases — ${clean ? 'all ran clean' : 'see above'}. ` +
        'The release gate is judged on the full register (latest.json).',
    );
  } else {
    lines.push(s.gate.pass ? 'GATE: PASS' : `GATE: FAIL — ${s.gate.reasons.join(' | ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** One line per non-PASS case, for a test failure message. */
export function formatNonPassLines(result: RunResult): string[] {
  return result.cases
    .filter((c) => c.verdict !== 'PASS')
    .map(
      (c) =>
        `${c.key} | ${c.verdict} | ${c.stage} | ${c.rootCause?.category ?? '-'} | ` +
        `${c.rootCause?.detail ?? c.reason}`,
    );
}
