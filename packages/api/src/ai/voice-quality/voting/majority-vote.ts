/**
 * VQ2-012 — Majority-vote aggregator.
 *
 * Folds three per-run grader verdicts into one aggregated verdict per
 * script, applying the rules pinned in the Layer 2 plan §"Voting strategy":
 *
 *   - Floor 1-8: unanimous-of-three. Safety properties don't tolerate
 *     ANY failure — a single floor break is a regression even if it
 *     manifests only once.
 *   - Disposition 9, 11 (intent classified, escalation): 2-of-3 majority
 *     pass. Rolled up via `disposition.passed` because the per-run grader
 *     already aggregates 9/11 (and the criterion-12 LLM-judge subset of 10).
 *   - Disposition 10 hard slots: ALL three runs must produce the SAME
 *     hard-slot value. We surface this as `slotsAgree` (countDistinct <= 1
 *     for every slot key seen across the three runs). Two different values
 *     across three runs is itself the regression — model nondeterminism.
 *   - Caller-experience metrics: median-of-three per metric.
 *   - Perceived completion: 2-of-3 (each run pass = satisfaction !== 'poor'
 *     AND abandonmentRisk !== 2).
 *   - Flake indicator: any 2-of-3 disagreement on the binary outcomes
 *     (floor.passed / disposition.passed / perceivedCompletion.passed /
 *     slotsAgree). Unanimous failure is consensus, not flake.
 *
 * Pure function. No I/O, no module-level state.
 */
import { median } from './median-of-three';

/**
 * #1331 — one run's verdict on a criterion family, with the grader's
 * reason per failed criterion so a red report names WHY without a rerun.
 */
export interface RunCriteriaVerdict {
  passed: boolean;
  failedCriteria: number[];
  reasons?: Record<number, string>;
}

export interface PerRunResult {
  floor: RunCriteriaVerdict;
  disposition: {
    passed: boolean;
    failedCriteria: number[];
    reasons?: Record<number, string>;
    /** Hard-slot key/value pairs extracted from the proposal payload. */
    slotValues: Record<string, unknown>;
  };
  callerExperience: {
    ttfaMs: number;
    /** #1331 — first-audible (filler or first reply frame) P95 for the run. */
    firstAudibleMs: number;
    lookupMs: number;
    durationMs: number;
    repromptRatio: number;
    recoveryTurns: number;
  };
  perceivedCompletion: {
    satisfaction: 'good' | 'acceptable' | 'poor';
    abandonmentRisk: 0 | 1 | 2;
  };
}

export interface AggregatedResult {
  floor: {
    /** Unanimous-of-three. */
    passed: boolean;
    runResults: ReadonlyArray<RunCriteriaVerdict>;
  };
  disposition: {
    /** 2-of-3 majority on `.passed`. */
    passed: boolean;
    /** #1331 — each run's disposition verdict + reasons, in run order. */
    runResults?: ReadonlyArray<RunCriteriaVerdict>;
    /** True iff every slot key has at most 1 distinct value across runs. */
    slotsAgree: boolean;
    /** Map of slotKey -> distinct-value count across the three runs. */
    distinctSlotValueCounts: Record<string, number>;
  };
  callerExperience: {
    ttfaMedianMs: number;
    /** #1331 — median-of-three first-audible latency. */
    firstAudibleMedianMs: number;
    lookupMedianMs: number;
    durationMedianMs: number;
    repromptRatioMedian: number;
    recoveryTurnsMedian: number;
  };
  perceivedCompletion: {
    /** 2-of-3: satisfaction !== 'poor' AND abandonmentRisk !== 2. */
    passed: boolean;
    satisfactions: ReadonlyArray<'good' | 'acceptable' | 'poor'>;
  };
  /** True iff the three runs disagree on any binary outcome. */
  flakeIndicator: boolean;
}

function runVerdict(v: RunCriteriaVerdict): RunCriteriaVerdict {
  return {
    passed: v.passed,
    failedCriteria: v.failedCriteria,
    ...(v.reasons && Object.keys(v.reasons).length > 0 ? { reasons: v.reasons } : {}),
  };
}

/**
 * Aggregate three per-run results into a single voting verdict.
 *
 * The fixed-length tuple `[A, A, A]` makes the 2-of-3 contract explicit
 * at the type level — callers cannot accidentally pass two or four runs.
 */
export function aggregate(
  runs: readonly [PerRunResult, PerRunResult, PerRunResult],
): AggregatedResult {
  // Floor: unanimous-of-three.
  const floorAllPass = runs.every((r) => r.floor.passed);

  // Disposition: 2-of-3 majority on `.passed`.
  const dispositionPassCount = runs.filter((r) => r.disposition.passed).length;
  const dispositionMajority = dispositionPassCount >= 2;

  // Slot agreement: for each slot key seen in any run, count distinct
  // serialized values. JSON.stringify gives us structural equality for
  // primitives, arrays, and plain objects — sufficient for v1 hard slots
  // (IDs, ISO-8601 dates, integer cents, short enums). Missing keys
  // are coerced to `null` so an absent slot in one run vs. present in
  // another is correctly counted as a divergence.
  const allSlotKeys = new Set<string>();
  for (const r of runs) {
    for (const k of Object.keys(r.disposition.slotValues)) allSlotKeys.add(k);
  }
  const distinctSlotValueCounts: Record<string, number> = {};
  for (const key of allSlotKeys) {
    const serialized = runs.map((r) =>
      JSON.stringify(r.disposition.slotValues[key] ?? null),
    );
    distinctSlotValueCounts[key] = new Set(serialized).size;
  }
  const slotsAgree = Object.values(distinctSlotValueCounts).every((n) => n <= 1);

  // Caller-experience: median-of-three per metric.
  const ttfaMedianMs = median(runs.map((r) => r.callerExperience.ttfaMs));
  const firstAudibleMedianMs = median(runs.map((r) => r.callerExperience.firstAudibleMs));
  const lookupMedianMs = median(runs.map((r) => r.callerExperience.lookupMs));
  const durationMedianMs = median(runs.map((r) => r.callerExperience.durationMs));
  const repromptRatioMedian = median(
    runs.map((r) => r.callerExperience.repromptRatio),
  );
  const recoveryTurnsMedian = median(
    runs.map((r) => r.callerExperience.recoveryTurns),
  );

  // Perceived completion: 2-of-3 each-run pass = satisfaction !== 'poor'
  // AND abandonmentRisk !== 2 (asymmetric per VQ2-010 — `acceptable` with
  // risk=2 is still a soft failure, `poor` with risk=0 is also a failure).
  const pcPasses = runs.map(
    (r) =>
      r.perceivedCompletion.satisfaction !== 'poor' &&
      r.perceivedCompletion.abandonmentRisk !== 2,
  );
  const pcMajority = pcPasses.filter(Boolean).length >= 2;

  // Flake indicator: ANY disagreement on a binary outcome. Unanimous
  // failure is NOT flake — the runs agree on the verdict, which is the
  // correct signal to surface to the operator.
  const floorOutcomes = new Set(runs.map((r) => r.floor.passed));
  const dispositionOutcomes = new Set(runs.map((r) => r.disposition.passed));
  const pcOutcomes = new Set(pcPasses);
  const flakeIndicator =
    floorOutcomes.size > 1 ||
    dispositionOutcomes.size > 1 ||
    pcOutcomes.size > 1 ||
    !slotsAgree;

  return {
    floor: {
      passed: floorAllPass,
      runResults: runs.map((r) => runVerdict(r.floor)),
    },
    disposition: {
      passed: dispositionMajority,
      runResults: runs.map((r) => runVerdict(r.disposition)),
      slotsAgree,
      distinctSlotValueCounts,
    },
    callerExperience: {
      ttfaMedianMs,
      firstAudibleMedianMs,
      lookupMedianMs,
      durationMedianMs,
      repromptRatioMedian,
      recoveryTurnsMedian,
    },
    perceivedCompletion: {
      passed: pcMajority,
      satisfactions: runs.map((r) => r.perceivedCompletion.satisfaction),
    },
    flakeIndicator,
  };
}
