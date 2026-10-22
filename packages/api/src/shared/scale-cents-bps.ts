/**
 * Scale integer cents by basis points, then round to the nearest whole dollar
 * (half up). The single rounding rule for every price derived from another
 * price in onboarding (premium tiers, pack seeds scaled to a chosen rate).
 * Shared here because both the price-tier resolver and the pack seeder need
 * it and neither should import the other.
 */
import { applyBps } from './billing-engine';

export function scaleCentsBps(cents: number, bps: number): number {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`scaleCentsBps: cents must be a non-negative integer, got ${cents}`);
  }
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(`scaleCentsBps: bps must be a non-negative integer, got ${bps}`);
  }
  // The percent-of-money step is the billing engine's (I9: one engine for all
  // financial math); only the round-to-the-dollar presentation rule is ours.
  const scaled = applyBps(cents, bps);
  return Math.round(scaled / 100) * 100;
}
