/**
 * VQ2-017 — Voice Quality weekly Slack poster.
 *
 * Run from CI as part of the weekly workflow:
 *
 *     npx ts-node .github/scripts/post-voice-quality-slack.ts
 *
 * Inputs (env):
 *   - SLACK_WEBHOOK_URL : incoming webhook URL for the voice-quality
 *                         channel. When unset the script logs + exits 0
 *                         (so CI doesn't fail on a forgotten secret).
 *   - REPORT_PATH       : path to the current Layer2Report JSON
 *                         (default: packages/api/voice-quality-layer2-report.json)
 *   - TREND_PATH        : OPTIONAL path to the trend report JSON
 *                         produced by voice-quality-trend-report.ts
 *
 * # Body shape
 *
 * Slack does not love long tables, so the body is intentionally tight
 * (4–5 lines):
 *
 *   *[Voice Quality — weekly trend]*
 *   This week: 13/14 (92.8%), TTFA P95 720ms, cost $7.40
 *   Vs last week: -7.1pp passes, TTFA -30ms, cost +$0.20
 *   Flakes: 1 script(s)
 *
 * Cost-capped lines surface only when the count is non-zero. The
 * regression note (if any) is emitted by the trend script and re-rendered
 * here verbatim.
 *
 * # Failure tolerance
 *
 * The script uses `process.exit(0)` on any failure path (best-effort).
 * The workflow's slack step uses `continue-on-error: true` as a
 * second belt; the weekly run's value is the artifact + auto-issue,
 * not the Slack post.
 */
import * as fs from 'fs';
import type { Layer2Report } from '../../packages/api/src/ai/voice-quality/report-layer2';

/**
 * Loose type for the trend report — kept as `any`-shaped here so the
 * Slack poster can absorb future trend-shape evolution without a build
 * coupling. The real shape lives in voice-quality-trend-report.ts.
 */
interface TrendReportLike {
  generatedAt: string;
  currentRun?: {
    overallPassRate: number;
    ttfaP95Ms: number;
    perceivedCompletionRate: number;
    totalCostCents: number;
    flakeCount: number;
  };
  prior?: TrendReportLike['currentRun'];
  deltas?: {
    overallPassRatePct: number;
    ttfaP95DeltaMs: number;
    perceivedCompletionPct: number;
    costDeltaCents: number;
  };
  regressionDetected?: boolean;
  notes?: string[];
}

/** Sign helper: prefix `+` for non-negative numbers. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

/** Render a signed dollar delta from cents (e.g. 20 → "+$0.20"). */
function signedDollarsFromCents(cents: number): string {
  const dollars = (Math.abs(cents) / 100).toFixed(2);
  return cents >= 0 ? `+$${dollars}` : `-$${dollars}`;
}

/**
 * Build the Slack message body. Pure function — exposed for unit tests.
 *
 * Returns a plain-text body (we use Slack's `text` field rather than
 * Block Kit; the tight 4-5-line shape doesn't benefit from blocks, and
 * keeping it text-only avoids a second contract surface).
 */
export function buildSlackBody(
  report: Layer2Report | null,
  trend: TrendReportLike | null,
): string {
  if (!report) {
    return '*[Voice Quality]* weekly run produced no report — see job logs.';
  }
  const lines: string[] = [];
  lines.push('*[Voice Quality — weekly trend]*');
  const passPct = (report.overallPassRate * 100).toFixed(1);
  lines.push(
    `This week: ${report.totalPassedAggregate}/${report.totalScripts} (${passPct}%), TTFA P95 ${report.callerExperience.ttfaMedians.p95.toFixed(
      0,
    )}ms, cost $${(report.cost.totalCents / 100).toFixed(2)}`,
  );

  if (trend?.deltas) {
    const ppDelta = trend.deltas.overallPassRatePct;
    const ttfaDelta = trend.deltas.ttfaP95DeltaMs;
    const costDelta = trend.deltas.costDeltaCents;
    lines.push(
      `Vs last week: ${signed(parseFloat(ppDelta.toFixed(1)))}pp passes, TTFA ${signed(
        Math.round(ttfaDelta),
      )}ms, cost ${signedDollarsFromCents(costDelta)}`,
    );
  } else if (trend?.notes && trend.notes.length > 0) {
    // No prior data — surface the baseline note so reviewers know why
    // there's no WoW comparison.
    lines.push(`Trend: ${trend.notes.join('; ')}`);
  }

  if (report.flakes.length > 0) {
    lines.push(`Flakes: ${report.flakes.length} script(s)`);
  }
  if (report.costCapped.length > 0) {
    lines.push(`:warning: Cost-capped: ${report.costCapped.length} script(s)`);
  }

  return lines.join('\n');
}

interface RunOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function run(opts: RunOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    // eslint-disable-next-line no-console
    console.warn('[post-voice-quality-slack] no SLACK_WEBHOOK_URL; skipping');
    return 0;
  }

  const reportPath =
    env.REPORT_PATH ?? 'packages/api/voice-quality-layer2-report.json';
  const trendPath = env.TREND_PATH;

  let report: Layer2Report | null = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as Layer2Report;
  } catch {
    // ignore — buildSlackBody handles null
  }

  let trend: TrendReportLike | null = null;
  if (trendPath) {
    try {
      trend = JSON.parse(fs.readFileSync(trendPath, 'utf-8')) as TrendReportLike;
    } catch {
      // ignore — buildSlackBody handles null trend
    }
  }

  const text = buildSlackBody(report, trend);

  try {
    const resp = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[post-voice-quality-slack] webhook returned ${resp.status} ${resp.statusText}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[post-voice-quality-slack] webhook POST threw: ${(err as Error).message}`,
    );
  }
  return 0;
}

// Run when invoked directly (not when imported by tests).
if (require.main === module) {
  void run().then((code) => {
    process.exit(code);
  });
}
