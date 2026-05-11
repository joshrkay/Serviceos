/**
 * VQ2-012 — Median-of-three helper.
 *
 * Used by the majority-vote aggregator to fold three caller-experience
 * latency samples into a single value per metric. We deliberately use
 * the median (not P95-of-three) because P95 across N=3 samples is
 * statistically meaningless — see plan §"Voting strategy".
 *
 * Pure function. Input array is not mutated. Empty input returns 0 as
 * a defensive default; the voting harness only ever passes three
 * samples, but the helper is kept hardened so a future caller cannot
 * trip a runtime exception by feeding zero samples.
 */
export function median(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
