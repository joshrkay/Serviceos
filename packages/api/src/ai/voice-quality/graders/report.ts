/**
 * VQ-023 — Report aggregator + launch-gate verdict.
 *
 * Rolls per-script grader output into the spec §7.2 threshold table:
 *   - floor must pass on 100% of scripts (any single floor failure
 *     breaks the launch gate, regardless of overall pass rate)
 *   - happy buckets (01-03)            : 100%
 *   - edge buckets (04-07)             :  90%
 *   - adversarial buckets (08-10)      :  70%
 *   - overall                          :  90%
 *
 * Two outputs:
 *   - `aggregate(verdicts)` → `VoiceQualityReport`, the JSON shape CI
 *     consumes and the schema in `voice-quality-report.schema.json`
 *     pins.
 *   - `formatReportMarkdown(report)` → a deterministic Markdown summary
 *     suitable for PR comments. Determinism is important: the PR-comment
 *     poster (VQ-025) wants stable output so identical reports don't
 *     produce noisy diffs in the sticky comment.
 *
 * # Latency math
 * P50 / P95 are computed across **all** turn-latency samples from **all**
 * scripts (not per-script averages — averaging an average loses signal).
 * The percentile algorithm is the simplest defensible one for v1:
 *
 *     sortedSamples[Math.floor(p * (n - 1))]
 *
 * — i.e. nearest-rank (lower) over the sorted samples. For a single
 * sample we return that sample. For zero samples we return 0 (and the
 * test pins this behaviour). This is intentionally not a formal linear-
 * interpolation percentile; the report's percentiles are a soft signal,
 * not a claim against an SLO.
 *
 * # Launch-gate semantics
 * `launchGate.pass` is true iff:
 *   - no script has a floor failure
 *   - every bucket meets its threshold
 *   - the overall pass rate meets the overall threshold
 *
 * `launchGate.blockers` is a human-readable list. Floor failures are
 * enumerated by scriptId (so the PR comment can link directly to the
 * failing case). Bucket failures cite the bucket name + actual rate +
 * threshold (e.g. `'09-concurrency below threshold (0.50 < 0.70)'`).
 */
import type { FloorResult } from './floor';
import type { DispositionStructuredResult } from './disposition-structured';
import type { DispositionLlmResult } from './disposition-llm';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PerScriptVerdict {
  scriptId: string;
  bucket: string;
  passed: boolean;
  floorResult: FloorResult;
  dispositionStructuredResult: DispositionStructuredResult;
  /** Optional — undefined when LLM grading was skipped (e.g. no proposal to grade). */
  dispositionLlmResult?: DispositionLlmResult;
  durationMs: number;
  costCents: number;
  perTurnLatencyMs: number[];
}

export interface BucketVerdict {
  bucket: string;
  scriptCount: number;
  passCount: number;
  /** 0..1; 0 when scriptCount is 0 (vacuously). */
  passRate: number;
  /** From the threshold table; 0.9 (overall) for unrecognised buckets. */
  threshold: number;
  meetsThreshold: boolean;
  /** scriptIds in this bucket that did not pass. */
  failedScripts: string[];
}

export interface VoiceQualityReport {
  rubricVersion: string;
  /** ISO timestamp; aggregate stamps `new Date().toISOString()`. */
  generatedAt: string;
  totalScripts: number;
  totalPassed: number;
  overallPassRate: number;
  /** 0.90 per spec §7.2. */
  overallThreshold: number;
  meetsOverallThreshold: boolean;
  perBucket: BucketVerdict[];
  perScript: PerScriptVerdict[];
  costSummary: {
    totalCents: number;
    perBucketAverageCents: Record<string, number>;
  };
  latencySummary: {
    p50Ms: number;
    p95Ms: number;
    perBucketP95Ms: Record<string, number>;
  };
  launchGate: {
    pass: boolean;
    blockers: string[];
  };
}

// ─── Threshold table (spec §7.2) ─────────────────────────────────────────────

const THRESHOLDS: Record<string, number> = {
  '01-happy-lookups': 1.0,
  '02-happy-booker': 1.0,
  '03-lead-capture': 1.0,
  '04-identity-edges': 0.9,
  '05-compliance-edges': 0.9,
  '06-hangup-edges': 0.9,
  '07-out-of-scope': 0.9,
  '08-ambiguity': 0.7,
  '09-concurrency': 0.7,
  '10-adversarial': 0.7,
  // 11-spanish pins the "Spanish ≥90%" launch requirement explicitly rather
  // than leaning on the overall-0.9 fallback — so a regression that drops the
  // Spanish bucket is named as its own launch-gate blocker, not silently
  // absorbed into the overall rate.
  '11-spanish': 0.9,
};

const OVERALL_THRESHOLD = 0.9;
/** Floor must be 100% across ALL scripts. */
const FLOOR_THRESHOLD = 1.0;

const RUBRIC_VERSION = 'v1';

// ─── Percentile helper ───────────────────────────────────────────────────────

/**
 * Nearest-rank (lower) percentile across an unsorted sample array.
 *
 * Edge cases:
 *   - empty input → 0 (defensible: no signal, don't return NaN)
 *   - single sample → that sample (Math.floor(p*0) = 0)
 *
 * Note `p` is in [0, 1]. We deliberately don't interpolate — the spec
 * treats percentiles as a soft signal in the report, not an SLO claim.
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export function aggregate(verdicts: PerScriptVerdict[]): VoiceQualityReport {
  const totalScripts = verdicts.length;
  const totalPassed = verdicts.filter((v) => v.passed).length;
  const overallPassRate = totalScripts === 0 ? 0 : totalPassed / totalScripts;
  const meetsOverallThreshold =
    totalScripts > 0 && overallPassRate >= OVERALL_THRESHOLD;

  // Per-bucket rollup. We iterate bucket name in insertion order from
  // the verdicts array so report output reflects the corpus's natural
  // ordering. For deterministic Markdown we then sort by bucket name.
  const byBucket = new Map<string, PerScriptVerdict[]>();
  for (const v of verdicts) {
    const arr = byBucket.get(v.bucket) ?? [];
    arr.push(v);
    byBucket.set(v.bucket, arr);
  }

  const perBucket: BucketVerdict[] = [];
  const perBucketAverageCents: Record<string, number> = {};
  const perBucketP95Ms: Record<string, number> = {};

  // Sort bucket names alphabetically for stable output. Bucket ids are
  // already prefixed `NN-…` so lexicographic == numeric.
  const bucketNames = [...byBucket.keys()].sort();
  for (const name of bucketNames) {
    const items = byBucket.get(name)!;
    const passCount = items.filter((v) => v.passed).length;
    const passRate = items.length === 0 ? 0 : passCount / items.length;
    // Unrecognised buckets fall back to the overall threshold so
    // mis-labeled scripts don't silently pass.
    const threshold = THRESHOLDS[name] ?? OVERALL_THRESHOLD;
    const failedScripts = items.filter((v) => !v.passed).map((v) => v.scriptId);
    perBucket.push({
      bucket: name,
      scriptCount: items.length,
      passCount,
      passRate,
      threshold,
      meetsThreshold: passRate >= threshold,
      failedScripts,
    });

    const totalCents = items.reduce((s, v) => s + v.costCents, 0);
    perBucketAverageCents[name] = items.length === 0 ? 0 : totalCents / items.length;

    const allLatencies = items.flatMap((v) => v.perTurnLatencyMs);
    perBucketP95Ms[name] = percentile(allLatencies, 0.95);
  }

  // Cost + latency rollups across the whole report.
  const totalCents = verdicts.reduce((s, v) => s + v.costCents, 0);
  const allLatencies = verdicts.flatMap((v) => v.perTurnLatencyMs);
  const p50Ms = percentile(allLatencies, 0.5);
  const p95Ms = percentile(allLatencies, 0.95);

  // Launch-gate: floor failures short-circuit, then bucket thresholds,
  // then overall. We list ALL blockers (not just the first) so PR
  // comments help operators triage in one pass.
  const blockers: string[] = [];
  for (const v of verdicts) {
    if (!v.floorResult.passed) {
      blockers.push(
        `floor failure: ${v.scriptId} (criteria ${v.floorResult.failedCriteria.join(', ')})`,
      );
    }
  }
  for (const b of perBucket) {
    if (!b.meetsThreshold) {
      blockers.push(
        `${b.bucket} below threshold (${b.passRate.toFixed(2)} < ${b.threshold.toFixed(2)})`,
      );
    }
  }
  if (totalScripts > 0 && !meetsOverallThreshold) {
    blockers.push(
      `overall below threshold (${overallPassRate.toFixed(2)} < ${OVERALL_THRESHOLD.toFixed(2)})`,
    );
  }
  // An empty corpus is not a passing launch gate — call sites should
  // never aggregate an empty result and expect green.
  if (totalScripts === 0) {
    blockers.push('no scripts in report');
  }

  // Floor threshold is implicit in the per-script floor enumeration
  // above; reference the constant so callers / tooling can grep for it.
  void FLOOR_THRESHOLD;

  return {
    rubricVersion: RUBRIC_VERSION,
    generatedAt: new Date().toISOString(),
    totalScripts,
    totalPassed,
    overallPassRate,
    overallThreshold: OVERALL_THRESHOLD,
    meetsOverallThreshold,
    perBucket,
    perScript: verdicts,
    costSummary: {
      totalCents,
      perBucketAverageCents,
    },
    latencySummary: {
      p50Ms,
      p95Ms,
      perBucketP95Ms,
    },
    launchGate: {
      pass: blockers.length === 0,
      blockers,
    },
  };
}

// ─── Markdown formatter ──────────────────────────────────────────────────────

/**
 * Format a `VoiceQualityReport` as a deterministic Markdown summary.
 *
 * Output sections (in order):
 *   1. Title + overall pass rate + launch-gate verdict
 *   2. Bucket table (one row per bucket, sorted by bucket name)
 *   3. Failed scripts list (sorted by scriptId)
 *   4. Cost + latency footer
 *
 * Determinism: every iteration source is sorted explicitly, and the
 * caller is expected to fix `generatedAt` if it wants byte-for-byte
 * stability across runs (the test pins this contract).
 */
export function formatReportMarkdown(report: VoiceQualityReport): string {
  const lines: string[] = [];
  const overallPct = (report.overallPassRate * 100).toFixed(1);
  const gateBadge = report.launchGate.pass ? 'PASS' : 'FAIL';

  lines.push(`# Voice Quality Report (rubric ${report.rubricVersion})`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`**Launch gate: ${gateBadge}**`);
  lines.push('');
  lines.push(
    `Overall: ${report.totalPassed}/${report.totalScripts} (${overallPct}%) — threshold ${(
      report.overallThreshold * 100
    ).toFixed(0)}%`,
  );
  lines.push('');

  // Per-bucket table.
  lines.push('## Per-bucket results');
  lines.push('');
  lines.push('| Bucket | Pass | Total | Rate | Threshold | Meets? |');
  lines.push('| --- | ---:| ---:| ---:| ---:| :---: |');
  const sortedBuckets = [...report.perBucket].sort((a, b) =>
    a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0,
  );
  for (const b of sortedBuckets) {
    const rate = (b.passRate * 100).toFixed(1);
    const thr = (b.threshold * 100).toFixed(0);
    const meets = b.meetsThreshold ? 'yes' : 'no';
    lines.push(
      `| ${b.bucket} | ${b.passCount} | ${b.scriptCount} | ${rate}% | ${thr}% | ${meets} |`,
    );
  }
  lines.push('');

  // Failed scripts.
  const failed = [...report.perScript]
    .filter((v) => !v.passed)
    .sort((a, b) => (a.scriptId < b.scriptId ? -1 : a.scriptId > b.scriptId ? 1 : 0));
  lines.push('## Failed scripts');
  lines.push('');
  if (failed.length === 0) {
    lines.push('_None._');
  } else {
    for (const v of failed) {
      const failedFloor =
        v.floorResult.failedCriteria.length > 0
          ? ` floor=[${v.floorResult.failedCriteria.join(',')}]`
          : '';
      const failedStruct =
        v.dispositionStructuredResult.failedCriteria.length > 0
          ? ` structured=[${v.dispositionStructuredResult.failedCriteria.join(',')}]`
          : '';
      const failedLlm =
        v.dispositionLlmResult && v.dispositionLlmResult.failedCriteria.length > 0
          ? ` llm=[${v.dispositionLlmResult.failedCriteria.join(',')}]`
          : '';
      lines.push(`- \`${v.scriptId}\` (${v.bucket})${failedFloor}${failedStruct}${failedLlm}`);
    }
  }
  lines.push('');

  // Launch-gate blockers.
  if (report.launchGate.blockers.length > 0) {
    lines.push('## Launch-gate blockers');
    lines.push('');
    for (const b of report.launchGate.blockers) {
      lines.push(`- ${b}`);
    }
    lines.push('');
  }

  // Cost + latency footer.
  lines.push('## Cost & latency');
  lines.push('');
  lines.push(`- Total cost: ${report.costSummary.totalCents}¢`);
  lines.push(`- P50 turn latency: ${report.latencySummary.p50Ms}ms`);
  lines.push(`- P95 turn latency: ${report.latencySummary.p95Ms}ms`);

  return lines.join('\n');
}
