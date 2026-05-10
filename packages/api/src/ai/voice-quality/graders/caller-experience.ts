/**
 * VQ2-009 — Mechanical caller-experience grader.
 *
 * Applies hard latency / duration thresholds to per-call audio timings
 * captured by the VQ2-004 helpers. The grader is a pure function: given
 * an `Observation` + the originating `VoiceQualityScript` + (optionally)
 * a thresholds bag, it returns pass/fail per metric and a flat list of
 * failed-metric tags so the runner can attach them to a report row.
 *
 * Three metrics are evaluated:
 *   - `ttfa`        — P95 of `ttfaPerTurn` ≤ 800ms
 *   - `lookupSpeak` — P95 of `lookupToSpeakLatency` ≤ 2000ms
 *   - `duration`    — only on happy-path buckets (01/02/03), the total
 *                     wall-clock call duration ≤ 90s
 *
 * "No measurement = no failure": if a latency array is empty (the call
 * never produced a transcript turn or never executed a lookup), the
 * corresponding metric trivially passes. This avoids penalizing scripts
 * that legitimately have no lookups (e.g., out-of-scope buckets).
 *
 * Non-happy-path buckets (04+) are exempt from the duration cap because
 * identity-edge / compliance-edge / adversarial scenarios routinely
 * take longer by design — we don't want to confuse a thorough handling
 * of a hard scenario with a hung or stuck call.
 */
import {
  ttfaPerTurn,
  lookupToSpeakLatency,
  totalCallDurationMs,
} from '../audio/audio-timings';
import type { Observation } from '../observation';
import type { VoiceQualityScript } from '../schema';

export interface CallerExperienceThresholds {
  /** P95 cap on per-turn TTFA. Default 800ms (spec §6.2). */
  ttfaP95MaxMs: number;
  /** P95 cap on lookup→speak latency. Default 2000ms (spec §6.2). */
  lookupP95MaxMs: number;
  /** Total-duration cap for buckets 01/02/03 only. Default 90s (spec §6.2). */
  happyPathMaxMs: number;
}

export const DEFAULT_CALLER_EXPERIENCE_THRESHOLDS: CallerExperienceThresholds = {
  ttfaP95MaxMs: 800,
  lookupP95MaxMs: 2000,
  happyPathMaxMs: 90_000,
};

export interface CallerExperienceResult {
  /** Computed P95 of per-turn TTFA values (0 when no turns recorded). */
  ttfaP95Ms: number;
  /** Computed P95 of lookup→speak latencies (0 when no lookups recorded). */
  lookupP95Ms: number;
  /** Total wall-clock duration of the call from event-bus timestamps. */
  totalDurationMs: number;
  passes: {
    ttfa: boolean;
    lookupSpeak: boolean;
    duration: boolean;
  };
  /** Stable enumeration of failed metric tags. Empty when all passed. */
  failedMetrics: Array<'ttfa' | 'lookupSpeak' | 'duration'>;
}

/**
 * Buckets that count as "happy path" for the duration cap. Edge buckets
 * (identity, compliance, hangup, out-of-scope, ambiguity, concurrency,
 * adversarial) are exempt because they legitimately run longer.
 */
const HAPPY_PATH_BUCKETS = new Set<string>([
  '01-happy-lookups',
  '02-happy-booker',
  '03-lead-capture',
]);

/**
 * Pure function: grades caller-experience metrics from an Observation.
 * Does no I/O. The latency arrays come from `audio-timings.ts`; if any
 * of them is empty, that metric trivially passes.
 */
export function gradeCallerExperience(
  observation: Observation,
  script: VoiceQualityScript,
  thresholds: CallerExperienceThresholds = DEFAULT_CALLER_EXPERIENCE_THRESHOLDS,
): CallerExperienceResult {
  const ttfas = ttfaPerTurn(observation.events);
  const lookupLatencies = lookupToSpeakLatency(observation.events);
  const totalMs = totalCallDurationMs(observation.events);

  const ttfaP95 = percentile(ttfas, 95);
  const lookupP95 = percentile(lookupLatencies, 95);
  const isHappyPath = HAPPY_PATH_BUCKETS.has(script.bucket);

  const passes = {
    ttfa: ttfas.length === 0 || ttfaP95 <= thresholds.ttfaP95MaxMs,
    lookupSpeak:
      lookupLatencies.length === 0 || lookupP95 <= thresholds.lookupP95MaxMs,
    duration: !isHappyPath || totalMs <= thresholds.happyPathMaxMs,
  };

  const failedMetrics: CallerExperienceResult['failedMetrics'] = [];
  if (!passes.ttfa) failedMetrics.push('ttfa');
  if (!passes.lookupSpeak) failedMetrics.push('lookupSpeak');
  if (!passes.duration) failedMetrics.push('duration');

  return {
    ttfaP95Ms: ttfaP95,
    lookupP95Ms: lookupP95,
    totalDurationMs: totalMs,
    passes,
    failedMetrics,
  };
}

/**
 * Nearest-rank percentile, matching the convention used by the VQ-023
 * report aggregator. Conventions:
 *   - Empty array → 0 (caller treats this as "no measurement").
 *   - Single-sample → that sample (avoids index 0 vs. n-1 ambiguity).
 *   - Otherwise sorted ascending; index = floor(p/100 * (n-1)).
 */
function percentile(samples: ReadonlyArray<number>, p: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0];
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}
