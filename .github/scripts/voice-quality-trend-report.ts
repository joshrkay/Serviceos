/**
 * VQ2-017 — Voice Quality Layer 2 weekly *trend report* builder.
 *
 * Run from CI as part of the weekly workflow:
 *
 *     npx ts-node .github/scripts/voice-quality-trend-report.ts
 *     npx ts-node .github/scripts/voice-quality-trend-report.ts --open-issue
 *
 * Inputs (env):
 *   - REPORT_PATH        : path to the current week's Layer2Report JSON
 *                          (default: packages/api/voice-quality-layer2-report.json)
 *   - TREND_PRIOR_PATH   : OPTIONAL path to the prior week's Layer2Report
 *                          JSON. v1 simplification: a single prior report
 *                          rather than the 8-week history the plan calls
 *                          for.
 *   - TREND_OUTPUT_PATH  : where to write the trend JSON
 *                          (default: packages/api/voice-quality-trend-report.json)
 *   - GITHUB_TOKEN       : token used to open a regression issue when
 *                          `--open-issue` is passed
 *   - GITHUB_REPOSITORY  : `<owner>/<repo>` (Actions sets this)
 *
 * # v1 simplification
 *
 * The plan (§VQ2-017 "trend persistence") calls for the last 8 weekly
 * reports being read from a fixed S3 prefix
 * (`s3://serviceos-ci-artifacts/voice-quality/<YYYY-MM-DD>.json`). For
 * v1 we compare the current run to AT MOST one prior report, sourced
 * from `TREND_PRIOR_PATH`. When that env var is unset (the common case
 * on first deployment, before any history exists) the trend report is a
 * "baseline" run — `regressionDetected: false`, `notes: ['…baseline…']`,
 * and `prior` / `deltas` are omitted.
 *
 * Follow-up (v1.5): wire S3 prefix retention + a multi-week diff. The
 * trend output shape (`prior`, `deltas`, `regressionDetected`) is
 * forward-compatible — we only need to widen `prior` to an array
 * downstream.
 *
 * # Regression detection
 *
 * `regressionDetected = true` iff the overall pass rate dropped more
 * than 5 percentage points week-over-week. A 5pp drop exactly does NOT
 * trip the alert (matches plan: "drops >5pp"). When tripped AND the
 * `--open-issue` flag is passed, we POST to the GitHub issues API with
 * a `voice-quality-regression` label.
 *
 * # Failure tolerance
 *
 * The script never throws. Missing report → empty trend file written +
 * exit 0 (so the workflow's slack/upload steps still see something on
 * disk). Missing prior → baseline run. GitHub issue POST failure →
 * logged + swallowed.
 */
import * as fs from 'fs';
import type { Layer2Report } from '../../packages/api/src/ai/voice-quality/report-layer2';

/** Serializable shape of a single weekly run, suitable for diffing. */
export interface TrendRunMetrics {
  overallPassRate: number;
  ttfaP95Ms: number;
  perceivedCompletionRate: number;
  totalCostCents: number;
  flakeCount: number;
}

/** Trend report shape — written to TREND_OUTPUT_PATH. */
export interface TrendReport {
  generatedAt: string;
  currentRun: TrendRunMetrics;
  prior?: TrendRunMetrics;
  /** Signed deltas, only present when a prior is available. */
  deltas?: {
    /** Signed pp change in overall pass rate (current minus prior). */
    overallPassRatePct: number;
    /** Signed ms change in TTFA P95 (current minus prior). */
    ttfaP95DeltaMs: number;
    /** Signed pp change in perceived-completion rate. */
    perceivedCompletionPct: number;
    /** Signed cents change in total cost. */
    costDeltaCents: number;
  };
  /** True when the overall pass rate dropped MORE THAN 5pp WoW. */
  regressionDetected: boolean;
  /** Human-readable notes; surfaced verbatim by the Slack poster. */
  notes: string[];
}

/** Read a Layer2Report JSON from disk; null on any error. */
export function loadReport(p: string): Layer2Report | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Layer2Report;
  } catch {
    return null;
  }
}

/** Project a Layer2Report into the slim TrendRunMetrics shape. */
function project(r: Layer2Report): TrendRunMetrics {
  return {
    overallPassRate: r.overallPassRate,
    ttfaP95Ms: r.callerExperience.ttfaMedians.p95,
    perceivedCompletionRate: r.callerExperience.perceivedCompletionRate,
    totalCostCents: r.cost.totalCents,
    flakeCount: r.flakes.length,
  };
}

/**
 * Pure trend-report builder. Exposed for unit tests.
 *
 * Threshold: regressionDetected fires when the pass-rate drop strictly
 * exceeds 5pp (i.e., -5.0001 trips it; -5.0 does not). This matches the
 * plan's wording "drops >5pp".
 */
export function buildTrendReport(
  current: Layer2Report,
  prior: Layer2Report | null,
  now: () => string = () => new Date().toISOString(),
): TrendReport {
  const trend: TrendReport = {
    generatedAt: now(),
    currentRun: project(current),
    notes: [],
    regressionDetected: false,
  };

  if (!prior) {
    trend.notes.push('No prior report available; baseline run.');
    return trend;
  }

  const priorMetrics = project(prior);
  trend.prior = priorMetrics;
  trend.deltas = {
    overallPassRatePct: (current.overallPassRate - prior.overallPassRate) * 100,
    ttfaP95DeltaMs:
      current.callerExperience.ttfaMedians.p95 - prior.callerExperience.ttfaMedians.p95,
    perceivedCompletionPct:
      (current.callerExperience.perceivedCompletionRate -
        prior.callerExperience.perceivedCompletionRate) *
      100,
    costDeltaCents: current.cost.totalCents - prior.cost.totalCents,
  };

  if (trend.deltas.overallPassRatePct < -5) {
    trend.regressionDetected = true;
    trend.notes.push(
      `Pass rate dropped ${(-trend.deltas.overallPassRatePct).toFixed(1)}pp WoW`,
    );
  }

  return trend;
}

interface OpenIssueOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  token: string;
  owner: string;
  repo: string;
  trend: TrendReport;
}

/**
 * Best-effort: POST a regression issue to the GitHub REST API. Errors
 * are logged but never thrown — the weekly workflow's `if: always()`
 * callers expect a clean exit.
 */
export async function openRegressionIssue(opts: OpenIssueOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = opts.apiBase ?? 'https://api.github.com';
  const dropPp = opts.trend.deltas?.overallPassRatePct ?? 0;
  const title = `voice-quality: weekly trend regression (${dropPp.toFixed(1)}pp drop)`;
  const body = [
    'Voice quality weekly trend detected a regression.',
    '',
    ...opts.trend.notes.map((n) => `- ${n}`),
    '',
    '**Current run:**',
    '```json',
    JSON.stringify(opts.trend.currentRun, null, 2),
    '```',
    '',
    '**Prior run:**',
    '```json',
    JSON.stringify(opts.trend.prior ?? null, null, 2),
    '```',
  ].join('\n');

  try {
    const resp = await fetchImpl(`${apiBase}/repos/${opts.owner}/${opts.repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'serviceos-voice-quality-trend',
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['voice-quality-regression'],
      }),
    });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[voice-quality-trend-report] failed to open regression issue: ${resp.status} ${resp.statusText}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[voice-quality-trend-report] regression-issue POST threw: ${
        (err as Error).message
      }`,
    );
  }
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  env?: NodeJS.ProcessEnv;
  argv?: string[];
}

export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv.slice(2);
  const openIssue = argv.includes('--open-issue');

  const reportPath =
    env.REPORT_PATH ?? 'packages/api/voice-quality-layer2-report.json';
  const priorPath = env.TREND_PRIOR_PATH;
  const trendOutputPath =
    env.TREND_OUTPUT_PATH ?? 'packages/api/voice-quality-trend-report.json';

  // The --open-issue invocation reads an existing trend report rather
  // than re-deriving it, so the issue body matches what was Slack-posted.
  if (openIssue) {
    let trend: TrendReport | null = null;
    try {
      const trendRaw = fs.readFileSync(env.TREND_PATH ?? trendOutputPath, 'utf-8');
      trend = JSON.parse(trendRaw) as TrendReport;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[voice-quality-trend-report] no trend report on disk; skipping --open-issue');
      return 0;
    }
    if (!trend?.regressionDetected) {
      // eslint-disable-next-line no-console
      console.log('[voice-quality-trend-report] no regression detected; skipping issue');
      return 0;
    }
    const token = env.GITHUB_TOKEN;
    const repository = env.GITHUB_REPOSITORY;
    if (!token || !repository || !repository.includes('/')) {
      // eslint-disable-next-line no-console
      console.warn('[voice-quality-trend-report] missing GITHUB_TOKEN/REPOSITORY; skipping issue');
      return 0;
    }
    const [owner, repo] = repository.split('/');
    await openRegressionIssue({
      fetchImpl: opts.fetchImpl,
      apiBase: opts.apiBase,
      token,
      owner,
      repo,
      trend,
    });
    return 0;
  }

  const current = loadReport(reportPath);
  if (!current) {
    // eslint-disable-next-line no-console
    console.warn(
      `[voice-quality-trend-report] no current report at ${reportPath}; emitting empty trend`,
    );
    fs.writeFileSync(
      trendOutputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          notes: ['no current report'],
          regressionDetected: false,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const prior = priorPath ? loadReport(priorPath) : null;
  const trend = buildTrendReport(current, prior);
  fs.writeFileSync(trendOutputPath, JSON.stringify(trend, null, 2));
  return 0;
}

// Run when invoked directly (not when imported by tests).
if (require.main === module) {
  void run().then((code) => {
    process.exit(code);
  });
}
