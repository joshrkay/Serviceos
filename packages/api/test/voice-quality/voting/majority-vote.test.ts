/**
 * VQ2-012 — Majority-vote aggregator tests.
 *
 * Pins the voting rules from the Layer 2 plan §"Voting strategy":
 *   - Floor 1-8: unanimous-of-three (any failure fails the aggregate)
 *   - Disposition 9, 11 + criterion 10 LLM-judge subset: 2-of-3 majority
 *   - Disposition 10 hard slots: distinct values across runs <= 1 (slot agreement)
 *   - Caller-experience: median-of-three (NOT P95-of-three)
 *   - Perceived completion: 2-of-3 (each run pass = satisfaction !== 'poor'
 *                          AND abandonmentRisk !== 2)
 *   - Flake indicator: any 2-of-3 disagreement on the binary outcomes
 *
 * Pure functions only — no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregate,
  type PerRunResult,
} from '../../../src/ai/voice-quality/voting/majority-vote';

function makeRun(overrides: Partial<PerRunResult> = {}): PerRunResult {
  return {
    floor: { passed: true, failedCriteria: [] },
    disposition: {
      passed: true,
      failedCriteria: [],
      slotValues: { customerId: 'cust_1', appointmentTimeIso: '2026-05-10T14:00:00Z' },
    },
    callerExperience: {
      ttfaMs: 200,
      lookupMs: 1000,
      durationMs: 60_000,
      repromptRatio: 0,
      recoveryTurns: 0,
    },
    perceivedCompletion: { satisfaction: 'good', abandonmentRisk: 0 },
    ...overrides,
  };
}

describe('VQ2-012 — majority-vote aggregator', () => {
  it('VQ2-012 — unanimous pass: all 3 runs pass everything', () => {
    const r = makeRun();
    const out = aggregate([r, r, r]);
    expect(out.floor.passed).toBe(true);
    expect(out.disposition.passed).toBe(true);
    expect(out.disposition.slotsAgree).toBe(true);
    expect(out.perceivedCompletion.passed).toBe(true);
    expect(out.flakeIndicator).toBe(false);
  });

  it('VQ2-012 — 2-of-3 disposition pass: aggregated.disposition.passed=true, flakeIndicator=true', () => {
    const pass = makeRun();
    const fail = makeRun({
      disposition: { passed: false, failedCriteria: [9], slotValues: pass.disposition.slotValues },
    });
    const out = aggregate([pass, pass, fail]);
    expect(out.disposition.passed).toBe(true);
    expect(out.flakeIndicator).toBe(true);
  });

  it('VQ2-012 — unanimous fail: 3 fail → aggregated fails, flakeIndicator=false (consensus on failure)', () => {
    const fail = makeRun({
      floor: { passed: false, failedCriteria: [3] },
      disposition: { passed: false, failedCriteria: [9], slotValues: { customerId: 'cust_1' } },
      perceivedCompletion: { satisfaction: 'poor', abandonmentRisk: 2 },
    });
    const out = aggregate([fail, fail, fail]);
    expect(out.floor.passed).toBe(false);
    expect(out.disposition.passed).toBe(false);
    expect(out.perceivedCompletion.passed).toBe(false);
    expect(out.flakeIndicator).toBe(false);
  });

  it('VQ2-012 — slot agreement fail: 3 different values for the same key', () => {
    const r1 = makeRun({
      disposition: { passed: true, failedCriteria: [], slotValues: { customerId: 'cust_1' } },
    });
    const r2 = makeRun({
      disposition: { passed: true, failedCriteria: [], slotValues: { customerId: 'cust_2' } },
    });
    const r3 = makeRun({
      disposition: { passed: true, failedCriteria: [], slotValues: { customerId: 'cust_3' } },
    });
    const out = aggregate([r1, r2, r3]);
    expect(out.disposition.slotsAgree).toBe(false);
    expect(out.disposition.distinctSlotValueCounts.customerId).toBe(3);
    expect(out.flakeIndicator).toBe(true);
  });

  it('VQ2-012 — slot agreement pass: 3 runs return same value', () => {
    const slots = { customerId: 'cust_1', amountCents: 4500 };
    const r = makeRun({
      disposition: { passed: true, failedCriteria: [], slotValues: slots },
    });
    const out = aggregate([r, r, r]);
    expect(out.disposition.slotsAgree).toBe(true);
    expect(out.disposition.distinctSlotValueCounts.customerId).toBe(1);
    expect(out.disposition.distinctSlotValueCounts.amountCents).toBe(1);
  });

  it('VQ2-012 — floor failure: 1 of 3 runs fails floor → aggregated.floor.passed=false (unanimous required)', () => {
    const ok = makeRun();
    const broken = makeRun({ floor: { passed: false, failedCriteria: [1] } });
    const out = aggregate([ok, ok, broken]);
    expect(out.floor.passed).toBe(false);
    expect(out.floor.runResults).toHaveLength(3);
    expect(out.floor.runResults[2]).toEqual({ passed: false, failedCriteria: [1] });
    expect(out.flakeIndicator).toBe(true);
  });

  it("VQ2-012 — perceived completion 2-of-3 'good' + 1 'poor' → passed=true, flakeIndicator=true", () => {
    const good = makeRun();
    const poor = makeRun({
      perceivedCompletion: { satisfaction: 'poor', abandonmentRisk: 1 },
    });
    const out = aggregate([good, good, poor]);
    expect(out.perceivedCompletion.passed).toBe(true);
    expect(out.perceivedCompletion.satisfactions).toEqual(['good', 'good', 'poor']);
    expect(out.flakeIndicator).toBe(true);
  });

  it("VQ2-012 — perceived completion all 'poor' → passed=false, flakeIndicator=false", () => {
    const poor = makeRun({
      perceivedCompletion: { satisfaction: 'poor', abandonmentRisk: 1 },
    });
    const out = aggregate([poor, poor, poor]);
    expect(out.perceivedCompletion.passed).toBe(false);
    expect(out.flakeIndicator).toBe(false);
  });

  it('VQ2-012 — abandonment risk 2 in any single run with otherwise good = that run is a fail; 2 fails → majority fail', () => {
    const ok = makeRun();
    const risk2 = makeRun({
      perceivedCompletion: { satisfaction: 'good', abandonmentRisk: 2 },
    });
    // 2 risk2 + 1 ok → majority fails
    const out = aggregate([risk2, risk2, ok]);
    expect(out.perceivedCompletion.passed).toBe(false);
    expect(out.flakeIndicator).toBe(true);
  });

  it('VQ2-012 — caller-experience medians: median([100,200,300]) === 200, median([100,100,300]) === 100', () => {
    const r1 = makeRun({
      callerExperience: { ttfaMs: 100, lookupMs: 100, durationMs: 100, repromptRatio: 0, recoveryTurns: 0 },
    });
    const r2 = makeRun({
      callerExperience: { ttfaMs: 200, lookupMs: 100, durationMs: 100, repromptRatio: 0.1, recoveryTurns: 1 },
    });
    const r3 = makeRun({
      callerExperience: { ttfaMs: 300, lookupMs: 300, durationMs: 100, repromptRatio: 0.2, recoveryTurns: 3 },
    });
    const out = aggregate([r1, r2, r3]);
    expect(out.callerExperience.ttfaMedianMs).toBe(200);
    expect(out.callerExperience.lookupMedianMs).toBe(100);
    expect(out.callerExperience.durationMedianMs).toBe(100);
    expect(out.callerExperience.repromptRatioMedian).toBeCloseTo(0.1);
    expect(out.callerExperience.recoveryTurnsMedian).toBe(1);
  });

  it('VQ2-012 — flake indicator: false when all dimensions consistent across runs', () => {
    const r = makeRun();
    const out = aggregate([r, r, r]);
    expect(out.flakeIndicator).toBe(false);
  });

  it('VQ2-012 — flake indicator: true on 2-of-3 disposition disagreement', () => {
    const pass = makeRun();
    const fail = makeRun({
      disposition: { passed: false, failedCriteria: [11], slotValues: pass.disposition.slotValues },
    });
    const out = aggregate([pass, fail, pass]);
    expect(out.flakeIndicator).toBe(true);
  });
});
