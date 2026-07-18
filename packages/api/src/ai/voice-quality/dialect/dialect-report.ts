/**
 * Dialect eval — per-dialect scoring + report aggregation.
 *
 * Pairs with `wer.ts` to answer "how well do we understand the dialects we
 * actually get called by?". A dialect eval case declares the ground-truth
 * transcript + expected intent for one accented utterance; the (future)
 * real-audio runner feeds the case's audio through Whisper, then this module
 * scores the result (WER + intent match + whether the agent clarified instead
 * of guessing) and rolls scores up into a per-dialect report with a
 * threshold gate.
 *
 * The split mirrors the rest of the harness: pure scoring/aggregation here
 * (unit-tested without assets), audio I/O in the runner. Mirrors
 * `report-layer2.ts`'s launch-gate shape so the same PR-comment poster can
 * render it.
 */
import { wordErrorRate, type WerResult } from './wer';

export interface DialectEvalCase {
  id: string;
  /** Human label for the accent/dialect, e.g. 'southern-us', 'indian-english'. */
  dialect: string;
  /** Ground-truth transcript of what the caller actually said. */
  referenceTranscript: string;
  /** Expected intent the agent should land on. Omit when the case only grades ASR. */
  expectedIntent?: string;
  /**
   * Path/key to the audio fixture for the real-audio (Layer-2) run. Optional
   * so the scoring/report layer is unit-testable without assets; the runner
   * that feeds Whisper resolves this when the dialect fixtures land.
   */
  audioFixture?: string;
}

export interface DialectEvalResult {
  caseId: string;
  dialect: string;
  /**
   * A4 — which ASR engine/path produced the hypothesis this result grades,
   * e.g. 'whisper' | 'deepgram'. Optional so single-surface / legacy call
   * sites (the original Whisper-only harness, direct `scoreDialectCase`
   * callers) are unaffected — `runDialectEval` stamps it when the caller
   * passes `options.surface`; omitted it means "surface not tracked for
   * this run" rather than a false default.
   */
  surface?: string;
  /** WER of the ASR hypothesis vs. the case's reference transcript. */
  wer: WerResult;
  /** Whether the agent acted on the expected intent; null when none was declared. */
  intentMatched: boolean | null;
  /** True when the agent confirmed/clarified rather than silently guessing. */
  clarified: boolean;
}

/** Observed behavior for one case after running ASR + the agent. */
export interface ObservedDialectCase {
  /** ASR hypothesis transcript. */
  transcript: string;
  /** Intent the agent acted on (null/undefined when none). */
  actedIntent?: string | null;
  /** Whether the agent confirmed understanding instead of guessing. */
  clarified: boolean;
}

/**
 * Score one case: WER of the hypothesis vs. reference + intent match. Intent
 * match is null when the case declared no `expectedIntent` (ASR-only case).
 */
export function scoreDialectCase(
  evalCase: DialectEvalCase,
  observed: ObservedDialectCase,
): DialectEvalResult {
  return {
    caseId: evalCase.id,
    dialect: evalCase.dialect,
    wer: wordErrorRate(evalCase.referenceTranscript, observed.transcript),
    intentMatched:
      evalCase.expectedIntent == null
        ? null
        : (observed.actedIntent ?? null) === evalCase.expectedIntent,
    clarified: observed.clarified,
  };
}

export interface DialectThresholds {
  /** Max acceptable mean WER per dialect. Default 0.15 (15%). */
  maxMeanWer: number;
  /** Min intent accuracy per dialect over cases with an expected intent. Default 0.9. */
  minIntentAccuracy: number;
}

export const DEFAULT_DIALECT_THRESHOLDS: DialectThresholds = {
  maxMeanWer: 0.15,
  minIntentAccuracy: 0.9,
};

export interface DialectStat {
  dialect: string;
  cases: number;
  meanWer: number;
  medianWer: number;
  /** Intent accuracy over cases that declared an expected intent; null when none did. */
  intentAccuracy: number | null;
  /** Fraction of cases where the agent clarified instead of guessing. */
  clarificationRate: number;
}

export interface DialectReport {
  totalCases: number;
  overallMeanWer: number;
  /** Per-dialect stats, sorted by dialect label for deterministic output. */
  perDialect: DialectStat[];
  /** Threshold breaches, human-readable; empty when pass=true. */
  blockers: string[];
  pass: boolean;
  thresholds: DialectThresholds;
}

/**
 * Aggregate per-case results into a per-dialect report + threshold verdict.
 * A dialect blocks when its mean WER exceeds `maxMeanWer`, or its intent
 * accuracy (when it has intent-bearing cases) is below `minIntentAccuracy`.
 */
export function buildDialectReport(
  results: ReadonlyArray<DialectEvalResult>,
  thresholds: DialectThresholds = DEFAULT_DIALECT_THRESHOLDS,
): DialectReport {
  const byDialect = new Map<string, DialectEvalResult[]>();
  for (const r of results) {
    const arr = byDialect.get(r.dialect) ?? [];
    arr.push(r);
    byDialect.set(r.dialect, arr);
  }

  const perDialect: DialectStat[] = [];
  const blockers: string[] = [];

  for (const dialect of [...byDialect.keys()].sort()) {
    const arr = byDialect.get(dialect)!;
    const wers = arr.map((r) => r.wer.wer);
    const meanWer = mean(wers);
    const withIntent = arr.filter((r) => r.intentMatched !== null);
    const intentAccuracy =
      withIntent.length === 0
        ? null
        : withIntent.filter((r) => r.intentMatched === true).length / withIntent.length;

    perDialect.push({
      dialect,
      cases: arr.length,
      meanWer,
      medianWer: median(wers),
      intentAccuracy,
      clarificationRate: arr.filter((r) => r.clarified).length / arr.length,
    });

    if (meanWer > thresholds.maxMeanWer) {
      blockers.push(
        `${dialect}: mean WER ${(meanWer * 100).toFixed(1)}% exceeds ${(
          thresholds.maxMeanWer * 100
        ).toFixed(0)}%`,
      );
    }
    if (intentAccuracy !== null && intentAccuracy < thresholds.minIntentAccuracy) {
      blockers.push(
        `${dialect}: intent accuracy ${(intentAccuracy * 100).toFixed(1)}% below ${(
          thresholds.minIntentAccuracy * 100
        ).toFixed(0)}%`,
      );
    }
  }

  return {
    totalCases: results.length,
    overallMeanWer: mean(results.map((r) => r.wer.wer)),
    perDialect,
    blockers,
    pass: blockers.length === 0,
    thresholds,
  };
}

/**
 * A4 — per-surface rollup (whisper vs deepgram vs …), mirroring `DialectStat`
 * but grouped by `DialectEvalResult.surface` instead of `dialect`. This is a
 * SEPARATE axis from the per-dialect rollup above — the same case can be
 * transcribed by multiple engines, so surface and dialect are independent
 * groupings over the same result set, not a nesting of one inside the other.
 * Results with no `surface` are grouped under `'unknown'` so a mixed batch
 * (some surface-tagged, some not) never silently drops rows.
 */
export interface SurfaceStat {
  surface: string;
  cases: number;
  meanWer: number;
  medianWer: number;
  /** Intent accuracy over cases that declared an expected intent; null when none did. */
  intentAccuracy: number | null;
  /** Fraction of cases where the agent clarified instead of guessing. */
  clarificationRate: number;
}

/**
 * Aggregate results into a per-surface WER/intent/clarification rollup.
 * Sorted by surface label for deterministic output (mirrors `perDialect`).
 * Pure — no threshold gate here; the surface axis is a measurement rollup,
 * not (yet) a pass/fail gate like `buildDialectReport`'s per-dialect one.
 */
export function buildSurfaceRollup(
  results: ReadonlyArray<DialectEvalResult>,
): SurfaceStat[] {
  const bySurface = new Map<string, DialectEvalResult[]>();
  for (const r of results) {
    const key = r.surface ?? 'unknown';
    const arr = bySurface.get(key) ?? [];
    arr.push(r);
    bySurface.set(key, arr);
  }

  const stats: SurfaceStat[] = [];
  for (const surface of [...bySurface.keys()].sort()) {
    const arr = bySurface.get(surface)!;
    const wers = arr.map((r) => r.wer.wer);
    const withIntent = arr.filter((r) => r.intentMatched !== null);
    stats.push({
      surface,
      cases: arr.length,
      meanWer: mean(wers),
      medianWer: median(wers),
      intentAccuracy:
        withIntent.length === 0
          ? null
          : withIntent.filter((r) => r.intentMatched === true).length / withIntent.length,
      clarificationRate: arr.filter((r) => r.clarified).length / arr.length,
    });
  }
  return stats;
}

function mean(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
