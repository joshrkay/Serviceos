/**
 * Scale integer cents by basis points, then round to the nearest whole dollar
 * (half up). The single rounding rule for every price derived from another
 * price in onboarding (premium tiers, pack seeds scaled to a chosen rate).
 * Shared here because both the price-tier resolver and the pack seeder need
 * it and neither should import the other.
 */
export function scaleCentsBps(cents: number, bps: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`scaleCentsBps: cents must be a non-negative integer, got ${cents}`);
  }
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`scaleCentsBps: bps must be a non-negative integer, got ${bps}`);
  }
  const scaled = Math.round((cents * bps) / 10_000);
  return Math.round(scaled / 100) * 100;
}
