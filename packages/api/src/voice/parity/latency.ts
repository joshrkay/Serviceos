/**
 * Voice-parity latency utilities.
 *
 * Pure percentile maths shared by the pickup-latency and emergency-handoff
 * benchmarks (Features 1 and 2). Kept dependency-free and deterministic so the
 * same helper backs both the standalone `bench:latency` script and the vitest
 * gates — a benchmark that asserts a number must compute that number the same
 * way the report prints it.
 *
 * Percentile method: nearest-rank on a 0-based sorted array. For a sample of
 * size n, the p-th percentile is the value at index `ceil(p/100 * n) - 1`,
 * clamped into range. This is the same definition used across the voice-quality
 * graders (caller-experience.ts) so reported p95s are comparable.
 */

export interface LatencyStats {
  /** Number of samples. */
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Nearest-rank percentile over a numeric sample. `p` is a percentage in
 * [0, 100]. Empty input returns 0 (callers gate on `count` before trusting a
 * percentile). Input is copied before sorting so the caller's array is intact.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const clampedP = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clampedP / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/** Compute the full latency distribution summary for a sample. */
export function summarize(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  return {
    count: samples.length,
    min,
    max,
    mean: sum / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
  };
}

/**
 * Time a synchronous or async thunk and return its result plus the elapsed
 * wall-clock milliseconds. Uses a monotonic high-resolution clock when present
 * (`performance.now`) so GC pauses and clock skew do not corrupt sub-ms
 * measurements; falls back to `Date.now` where `performance` is unavailable.
 */
export async function timed<T>(fn: () => T | Promise<T>): Promise<{ result: T; ms: number }> {
  const start = now();
  const result = await fn();
  return { result, ms: now() - start };
}

function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}
