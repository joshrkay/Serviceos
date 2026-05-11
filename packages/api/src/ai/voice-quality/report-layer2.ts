/**
 * VQ2-015 — Layer 2 report aggregator + launch-gate verdict.
 *
 * Wraps an array of `RunScriptLayer2Result` (one per script in the
 * Layer 2 corpus, 14 scripts at v1) into a single `Layer2Report` that
 * encodes:
 *
 *   - per-script aggregate-pass status (floor + disposition + perceived
 *     completion all majority-pass per VQ2-012's voting rules)
 *   - cross-script caller-experience percentiles (TTFA, lookup→speak)
 *   - cost rollup
 *   - flake list (scripts where the 3 runs disagreed)
 *   - cost-cap list (scripts aborted by VQ2-013's cost cap)
 *   - **launch-gate verdict**: pass/fail boolean + human-readable
 *     blockers list, sized for the PR-comment poster (VQ-025) and the
 *     pre-deploy CI workflow (VQ2-016).
 *
 * # Threshold table (from plan §"Caller-experience thresholds")
 *
 * | Metric                          | Threshold |
 * |---|---|
 * | Floor                           | 100% of scripts must pass unanimously |
 * | Overall disposition+CE pass     | ≥85% (12/14 at v1) |
 * | TTFA P95 across all turns       | ≤800 ms |
 * | Perceived completion pass rate  | ≥90% |
 * | Cost-capped scripts             | 0 |
 *
 * These constants live in `DEFAULT_LAYER2_THRESHOLDS`. Bumping any value
 * is a rubric version change (per Layer 1's discipline) — but the
 * rubric file itself encodes the same numbers under
 * `layer2CallerExperience`; this module accepts a thresholds parameter
 * so the CI runner can pass the rubric-derived values without this
 * module needing to read the rubric directly.
 *
 * # Percentile semantics
 *
 * TTFA / lookup percentiles here are computed across the **median TTFA
 * per script** (already a 3-run median from VQ2-012). The spec wants
 * "TTFA P95 across all turns of all scripts (median across 3 runs each)"
 * — which is what we get when the per-script median is already a turn-
 * level P95 (caller-experience grader returns ttfaP95Ms; voting takes
 * the median of those three P95s; this aggregator computes the P95 of
 * those medians across scripts). The semantics are "P95 of per-script
 * medianized P95s" — a soft signal, not an SLO claim — matching Layer 1's
 * intent in `report.ts`.
 *
 * The percentile algorithm is nearest-rank (lower) over the sorted
 * sample, mirroring Layer 1's helper. Empty input returns 0.
 *
 * # PR-comment compatibility
 *
 * The existing PR-comment poster (Layer 1's VQ-025) checks for a
 * top-level `launchGate.pass` boolean. The Layer 2 shape preserves that
 * exact path so the poster degrades gracefully when handed a Layer 2
 * report — the poster doesn't need a Layer 2 codepath to render the
 * green/red badge correctly.
 *
 * # `perBucket` cost aggregation
 *
 * Stubbed at v1. The plan §VQ2-015 calls for `cost.perBucket` keyed by
 * Layer-1-style bucket name (`01-happy-lookups`, etc), but Layer 2's
 * 14-script corpus is selected by `layer2Eligible` flags and doesn't
 * carry the bucket directory naming through `RunScriptLayer2Result`.
 * Adding a script→bucket lookup here would couple this module to the
 * corpus loader. Deferred until VQ2-016 wires the CI runner: at that
 * point the runner has the full corpus map and can either populate
 * `perBucket` directly or pass a bucket-of(scriptId) callback. For v1
 * the field is an empty record; consumers should not assume keys exist.
 */
import type { RunScriptLayer2Result } from './runner-layer2';
import type { AggregatedResult } from './voting/majority-vote';

// ─── Thresholds ───────────────────────────────────────────────────────────────

export interface Layer2LaunchGateThresholds {
  /** Floor passes required: 100% of scripts (unanimous-of-three per script). */
  floorAllScripts: true;
  /** Disposition + caller-experience aggregate pass rate. Default 85% (12/14 scripts). */
  overallPassRateMin: number;
  /** TTFA P95 ceiling (ms) across all scripts' median TTFA. Default 800 ms. */
  ttfaP95MaxMs: number;
  /** Perceived-completion pass rate floor. Default 90%. */
  perceivedCompletionPassRateMin: number;
  /** Maximum allowed cost-capped scripts. Default 0. */
  costCappedScriptsMax: number;
}

export const DEFAULT_LAYER2_THRESHOLDS: Layer2LaunchGateThresholds = {
  floorAllScripts: true,
  overallPassRateMin: 0.85,
  ttfaP95MaxMs: 800,
  perceivedCompletionPassRateMin: 0.9,
  costCappedScriptsMax: 0,
};

// ─── Report shape ─────────────────────────────────────────────────────────────

export interface Layer2Report {
  rubricVersion: string;
  /** ISO timestamp; buildLayer2Report stamps `new Date().toISOString()`. */
  generatedAt: string;
  totalScripts: number;
  totalPassedAggregate: number;
  overallPassRate: number;
  perScriptVerdicts: Array<{
    scriptId: string;
    aggregated: AggregatedResult;
    costCapped: boolean;
    totalCostCents: number;
    durationMs: number;
  }>;
  callerExperience: {
    ttfaMedians: { p50: number; p95: number };
    lookupMedians: { p50: number; p95: number };
    repromptRatioOverall: number;
    perceivedCompletionRate: number;
  };
  cost: {
    totalCents: number;
    perScriptAverageCents: number;
    /**
     * Best-effort per-bucket totals. Stubbed empty at v1 — see module
     * doc-comment "perBucket cost aggregation".
     */
    perBucket: Record<string, number>;
  };
  /** scriptIds where AggregatedResult.flakeIndicator === true. */
  flakes: string[];
  /** scriptIds where the per-script cost cap fired (RunScriptLayer2Result.costCapped). */
  costCapped: string[];
  launchGate: {
    pass: boolean;
    /** Human-readable reasons; empty when pass=true. */
    blockers: string[];
    thresholds: Layer2LaunchGateThresholds;
    measured: {
      floorAllPass: boolean;
      overallPassRate: number;
      ttfaP95Ms: number;
      perceivedCompletionPassRate: number;
      costCappedScripts: number;
    };
  };
}

// ─── Percentile helper ────────────────────────────────────────────────────────

/**
 * Nearest-rank (lower) percentile across an unsorted sample array.
 * Mirrors `report.ts::percentile` but takes p as a 0-100 integer (the
 * Layer-2 plan reads "P95" everywhere — keeping the unit explicit at
 * the call site).
 *
 * Edge cases:
 *   - empty input → 0
 *   - single sample → that sample
 */
function percentile(samples: ReadonlyArray<number>, p: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0];
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Per-script aggregate-pass: floor + disposition + perceived-completion
 * all majority-pass. We deliberately do NOT include `slotsAgree` — slot
 * disagreement is surfaced via `flakeIndicator` (a soft warning), not as
 * a hard gate, matching the plan's "majority pass" framing.
 */
function aggregatePasses(r: RunScriptLayer2Result): boolean {
  return (
    r.aggregated.floor.passed &&
    r.aggregated.disposition.passed &&
    r.aggregated.perceivedCompletion.passed
  );
}

export function buildLayer2Report(
  results: ReadonlyArray<RunScriptLayer2Result>,
  thresholds: Layer2LaunchGateThresholds = DEFAULT_LAYER2_THRESHOLDS,
  rubricVersion = 'v1',
): Layer2Report {
  const totalScripts = results.length;
  const totalPassedAggregate = results.filter(aggregatePasses).length;
  const overallPassRate = totalScripts === 0 ? 0 : totalPassedAggregate / totalScripts;

  // Caller-experience aggregations.
  // Filter zero medians — those are the synthetic "fail-everything" run
  // signal from runner-layer2.failEverythingRun() (ttfa=0, lookup=0).
  // Including them would skew P95 downward.
  const allTtfas = results.map((r) => r.aggregated.callerExperience.ttfaMedianMs).filter((n) => n > 0);
  const allLookups = results
    .map((r) => r.aggregated.callerExperience.lookupMedianMs)
    .filter((n) => n > 0);
  const ttfaMedians = { p50: percentile(allTtfas, 50), p95: percentile(allTtfas, 95) };
  const lookupMedians = { p50: percentile(allLookups, 50), p95: percentile(allLookups, 95) };

  const perceivedCompletionPasses = results.filter(
    (r) => r.aggregated.perceivedCompletion.passed,
  ).length;
  const perceivedCompletionRate = totalScripts === 0 ? 0 : perceivedCompletionPasses / totalScripts;

  const repromptRatioOverall =
    totalScripts === 0
      ? 0
      : results.reduce((s, r) => s + r.aggregated.callerExperience.repromptRatioMedian, 0) /
        totalScripts;

  // Cost rollup.
  const totalCents = results.reduce((s, r) => s + r.totalCostCents, 0);
  const perScriptAverageCents = totalScripts === 0 ? 0 : totalCents / totalScripts;
  const perBucket: Record<string, number> = {}; // v1 stub — see module doc-comment.

  // Lists.
  const flakes = results.filter((r) => r.aggregated.flakeIndicator).map((r) => r.scriptId);
  const costCapped = results.filter((r) => r.costCapped).map((r) => r.scriptId);

  // Launch gate.
  // Note: `every` of empty array is vacuously true; we check totalScripts
  // explicitly so an empty corpus still surfaces a blocker.
  const floorAllPass = totalScripts > 0 && results.every((r) => r.aggregated.floor.passed);
  const measured = {
    floorAllPass,
    overallPassRate,
    ttfaP95Ms: ttfaMedians.p95,
    perceivedCompletionPassRate: perceivedCompletionRate,
    costCappedScripts: costCapped.length,
  };

  const blockers: string[] = [];
  if (totalScripts === 0) {
    blockers.push('no scripts in report');
  }
  if (totalScripts > 0 && !floorAllPass) {
    const failingIds = results
      .filter((r) => !r.aggregated.floor.passed)
      .map((r) => r.scriptId)
      .join(', ');
    blockers.push(`floor failure on scripts: ${failingIds}`);
  }
  if (totalScripts > 0 && overallPassRate < thresholds.overallPassRateMin) {
    blockers.push(
      `overall pass rate ${(overallPassRate * 100).toFixed(1)}% below threshold ${(
        thresholds.overallPassRateMin * 100
      ).toFixed(0)}%`,
    );
  }
  if (totalScripts > 0 && ttfaMedians.p95 > thresholds.ttfaP95MaxMs) {
    blockers.push(
      `TTFA P95 ${ttfaMedians.p95.toFixed(0)}ms above threshold ${thresholds.ttfaP95MaxMs}ms`,
    );
  }
  if (totalScripts > 0 && perceivedCompletionRate < thresholds.perceivedCompletionPassRateMin) {
    blockers.push(
      `perceived completion ${(perceivedCompletionRate * 100).toFixed(1)}% below ${(
        thresholds.perceivedCompletionPassRateMin * 100
      ).toFixed(0)}%`,
    );
  }
  if (costCapped.length > thresholds.costCappedScriptsMax) {
    blockers.push(`${costCapped.length} cost-capped scripts: ${costCapped.join(', ')}`);
  }
  const launchGatePass = blockers.length === 0;

  return {
    rubricVersion,
    generatedAt: new Date().toISOString(),
    totalScripts,
    totalPassedAggregate,
    overallPassRate,
    perScriptVerdicts: results.map((r) => ({
      scriptId: r.scriptId,
      aggregated: r.aggregated,
      costCapped: r.costCapped,
      totalCostCents: r.totalCostCents,
      durationMs: r.durationMs,
    })),
    callerExperience: {
      ttfaMedians,
      lookupMedians,
      repromptRatioOverall,
      perceivedCompletionRate,
    },
    cost: {
      totalCents,
      perScriptAverageCents,
      perBucket,
    },
    flakes,
    costCapped,
    launchGate: {
      pass: launchGatePass,
      blockers,
      thresholds,
      measured,
    },
  };
}

// ─── Markdown formatter ───────────────────────────────────────────────────────

/**
 * Render a `Layer2Report` as a deterministic Markdown summary suitable
 * for Slack / GitHub PR comments. The output is intentionally compact
 * (the plan calls for ~30 lines): headline + summary + blockers + flakes
 * + cost-capped lists.
 *
 * Determinism: every iteration source is deterministic in the report
 * itself (we do not re-sort here); call sites that want byte-stable
 * output should pin `generatedAt` upstream.
 */
export function formatLayer2ReportMarkdown(report: Layer2Report): string {
  const lines: string[] = [];
  const gateBadge = report.launchGate.pass ? 'PASS' : 'FAIL';

  lines.push(`# Voice Quality Layer 2 Report`);
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Rubric:** ${report.rubricVersion}`);
  lines.push(`**Launch Gate:** ${gateBadge}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push(
    `- Scripts: ${report.totalPassedAggregate}/${report.totalScripts} (${(
      report.overallPassRate * 100
    ).toFixed(1)}%)`,
  );
  lines.push(`- TTFA median P95: ${report.callerExperience.ttfaMedians.p95.toFixed(0)}ms`);
  lines.push(
    `- Lookup→speak median P95: ${report.callerExperience.lookupMedians.p95.toFixed(0)}ms`,
  );
  lines.push(
    `- Perceived completion: ${(report.callerExperience.perceivedCompletionRate * 100).toFixed(
      1,
    )}%`,
  );
  lines.push(`- Total cost: $${(report.cost.totalCents / 100).toFixed(2)}`);
  lines.push('');
  if (report.launchGate.blockers.length > 0) {
    lines.push(`## Blockers`);
    for (const b of report.launchGate.blockers) lines.push(`- ${b}`);
    lines.push('');
  }
  if (report.flakes.length > 0) {
    lines.push(`## Flake-prone scripts`);
    for (const id of report.flakes) lines.push(`- ${id}`);
    lines.push('');
  }
  if (report.costCapped.length > 0) {
    lines.push(`## Cost-capped scripts`);
    for (const id of report.costCapped) lines.push(`- ${id}`);
    lines.push('');
  }
  return lines.join('\n');
}
