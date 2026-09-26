/**
 * baseline.ts — the regression gate for the voice-eval harness (#839).
 *
 * A baseline is a committed JSON file describing one eval (intent | slot) in
 * one mode (offline | live): the metrics it scored, the golden set it scored
 * them on (row count + order-independent fingerprint), and how far each metric
 * may drop before the gate fails (`tolerance`, an absolute fraction).
 *
 *   - offline runs are deterministic, so their baselines use tolerance 0 —
 *     any drop is a real regression;
 *   - live runs are sampled from a nondeterministic model, so their baselines
 *     carry a noise tolerance (see baselines/README.md for the numbers).
 *
 * The gate fails CLOSED: a `placeholder` baseline (not yet recorded — live
 * baselines need a paid run the owner makes) exits BASELINE_EXIT_NO_BASELINE,
 * and a golden set that changed under its baseline must be re-recorded in the
 * same PR, so a taxonomy/corpus change always ships with a reviewed baseline
 * diff. Pure + fs only: no api `src` imports, no network.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export type EvalName = 'intent' | 'slot';
export type EvalMode = 'offline' | 'live';

export interface GoldenSet {
  rows: number;
  fingerprint: string;
}

export interface EvalRunSummary {
  eval: EvalName;
  mode: EvalMode;
  goldenSet: GoldenSet;
  metrics: Record<string, number>;
}

export interface EvalBaseline {
  schemaVersion: 1;
  eval: EvalName;
  mode: EvalMode;
  status: 'recorded' | 'placeholder';
  recordedAt: string | null;
  goldenSet: GoldenSet | null;
  metrics: Record<string, number>;
  tolerance: number;
  /** The one command that (re-)records this baseline. */
  recordCommand: string;
}

export interface MetricDelta {
  metric: string;
  baseline: number;
  current: number;
  drop: number;
}

export type BaselineStatus = 'pass' | 'regressed' | 'no-baseline' | 'golden-set-changed' | 'mismatch';

export interface BaselineVerdict {
  status: BaselineStatus;
  pass: boolean;
  regressions: MetricDelta[];
  improvements: MetricDelta[];
  message: string;
}

/** Offline evals are deterministic: any drop at all is a regression. */
export const OFFLINE_BASELINE_TOLERANCE = 0;

/**
 * Live evals sample a nondeterministic model (no seed; temperature 0 is still
 * not deterministic). The runs are PAIRED — the same deterministic sample
 * every time — so run-to-run noise is label flips, not sampling error; 5pp
 * absolute is a starting band (Wilson 95% CI at p=0.92, n=200 is ±3.8pp).
 * Owner-tunable per file: re-recording keeps a baseline's existing tolerance.
 */
export const LIVE_BASELINE_TOLERANCE = 0.05;

/** Exit code when the baseline is an unrecorded placeholder (1 gate, 2 key, 3 cost). */
export const BASELINE_EXIT_NO_BASELINE = 4;

// Absorbs float noise so a deterministic run never fails against itself.
const EPSILON = 1e-9;

/** Order-independent 16-hex fingerprint of the golden rows (one key per row). */
export function fingerprintGoldenSet(keys: string[]): string {
  const h = createHash('sha256');
  for (const k of [...keys].sort()) h.update(k).update('\n');
  return h.digest('hex').slice(0, 16);
}

export function buildBaseline(
  run: EvalRunSummary,
  opts: { tolerance: number; recordedAt: string; recordCommand: string },
): EvalBaseline {
  return {
    schemaVersion: 1,
    eval: run.eval,
    mode: run.mode,
    status: 'recorded',
    recordedAt: opts.recordedAt,
    goldenSet: { ...run.goldenSet },
    metrics: { ...run.metrics },
    tolerance: opts.tolerance,
    recordCommand: opts.recordCommand,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function compareToBaseline(baseline: EvalBaseline, run: EvalRunSummary): BaselineVerdict {
  const verdict = (status: BaselineStatus, message: string, regressions: MetricDelta[] = [], improvements: MetricDelta[] = []): BaselineVerdict =>
    ({ status, pass: status === 'pass', regressions, improvements, message });

  if (baseline.eval !== run.eval || baseline.mode !== run.mode) {
    return verdict('mismatch', `baseline is for ${baseline.eval}/${baseline.mode}, run is ${run.eval}/${run.mode}`);
  }
  if (baseline.status === 'placeholder' || baseline.goldenSet === null) {
    return verdict('no-baseline', `no ${baseline.eval}/${baseline.mode} baseline has been recorded yet — record it with:\n     ${baseline.recordCommand}`);
  }
  if (baseline.goldenSet.fingerprint !== run.goldenSet.fingerprint || baseline.goldenSet.rows !== run.goldenSet.rows) {
    return verdict(
      'golden-set-changed',
      `the golden set changed (baseline ${baseline.goldenSet.rows} rows/${baseline.goldenSet.fingerprint}, ` +
        `run ${run.goldenSet.rows} rows/${run.goldenSet.fingerprint}) — re-record the baseline in this PR:\n     ${baseline.recordCommand}`,
    );
  }

  const regressions: MetricDelta[] = [];
  const improvements: MetricDelta[] = [];
  for (const [metric, base] of Object.entries(baseline.metrics)) {
    const current = run.metrics[metric];
    if (current === undefined || !Number.isFinite(current)) {
      regressions.push({ metric, baseline: base, current: Number.NaN, drop: Number.POSITIVE_INFINITY });
      continue;
    }
    const drop = base - current;
    if (drop > baseline.tolerance + EPSILON) regressions.push({ metric, baseline: base, current, drop });
    else if (current > base + EPSILON) improvements.push({ metric, baseline: base, current, drop });
  }
  if (regressions.length > 0) {
    const lines = regressions.map((r) =>
      Number.isFinite(r.current)
        ? `${r.metric} ${pct(r.baseline)} → ${pct(r.current)} (drop ${pct(r.drop)} > tolerance ${pct(baseline.tolerance)})`
        : `${r.metric} missing from the run`);
    return verdict('regressed', `regressed past baseline: ${lines.join('; ')}`, regressions, improvements);
  }
  const note = improvements.length > 0
    ? ` (improved: ${improvements.map((i) => `${i.metric} ${pct(i.baseline)} → ${pct(i.current)}`).join(', ')} — re-record to ratchet the baseline up)`
    : '';
  return verdict('pass', `within tolerance ${pct(baseline.tolerance)} of the ${baseline.recordedAt} baseline${note}`, [], improvements);
}

function argValue(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return undefined;
}

/** `--baseline <file>` compares against a baseline; `--record-baseline <file>` writes one. */
export function parseBaselineArgs(argv: string[]): { comparePath?: string; recordPath?: string } {
  return { comparePath: argValue(argv, '--baseline'), recordPath: argValue(argv, '--record-baseline') };
}

function isMetrics(v: unknown): v is Record<string, number> {
  return typeof v === 'object' && v !== null && Object.values(v).every((n) => typeof n === 'number');
}

export function readBaseline(path: string): EvalBaseline {
  const b = JSON.parse(readFileSync(path, 'utf8')) as Partial<EvalBaseline>;
  const ok =
    b.schemaVersion === 1 &&
    (b.eval === 'intent' || b.eval === 'slot') &&
    (b.mode === 'offline' || b.mode === 'live') &&
    (b.status === 'recorded' || b.status === 'placeholder') &&
    isMetrics(b.metrics) &&
    typeof b.tolerance === 'number' && b.tolerance >= 0 &&
    typeof b.recordCommand === 'string' &&
    (b.goldenSet === null || (typeof b.goldenSet?.rows === 'number' && typeof b.goldenSet?.fingerprint === 'string')) &&
    (b.status === 'placeholder' || (b.goldenSet !== null && typeof b.recordedAt === 'string'));
  if (!ok) throw new Error(`invalid voice-eval baseline file: ${path}`);
  return b as EvalBaseline;
}

export function writeBaseline(path: string, baseline: EvalBaseline): void {
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

export interface BaselineGateResult {
  /** 0 pass / recorded / not requested, 1 regression, BASELINE_EXIT_NO_BASELINE placeholder. */
  exitCode: number;
  message?: string;
}

function tryReadBaseline(path: string): EvalBaseline | undefined {
  try {
    return readBaseline(path);
  } catch {
    return undefined;
  }
}

/**
 * The runners' single entry point: record the run as a baseline
 * (`--record-baseline`), compare it against one (`--baseline`), or do nothing.
 * Re-recording over an existing file keeps its tolerance and record command,
 * so the owner-tuned noise band survives a refresh.
 */
export function applyBaselineGate(
  run: EvalRunSummary,
  args: { comparePath?: string; recordPath?: string },
  opts: { tolerance: number; recordCommand: string; now?: () => string },
): BaselineGateResult {
  if (args.recordPath) {
    const prior = tryReadBaseline(args.recordPath);
    const baseline = buildBaseline(run, {
      tolerance: prior?.tolerance ?? opts.tolerance,
      recordCommand: prior?.recordCommand ?? opts.recordCommand,
      recordedAt: (opts.now ?? (() => new Date().toISOString()))(),
    });
    writeBaseline(args.recordPath, baseline);
    return { exitCode: 0, message: `recorded ${run.eval}/${run.mode} baseline → ${args.recordPath}` };
  }
  if (args.comparePath) {
    const v = compareToBaseline(readBaseline(args.comparePath), run);
    const exitCode = v.pass ? 0 : v.status === 'no-baseline' ? BASELINE_EXIT_NO_BASELINE : 1;
    return { exitCode, message: `baseline ${v.status}: ${v.message}` };
  }
  return { exitCode: 0, message: undefined };
}
