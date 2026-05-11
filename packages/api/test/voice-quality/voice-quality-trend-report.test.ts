/**
 * VQ2-017 — Trend report integration tests.
 *
 * Pins the contract for `.github/scripts/voice-quality-trend-report.ts`:
 *
 *   - With no prior report on disk, regressionDetected=false and notes
 *     mention "baseline".
 *   - With a prior report and a small (4pp) drop, regressionDetected
 *     stays false (under the 5pp threshold).
 *   - With a prior report and a 6pp drop, regressionDetected=true and
 *     notes mention the drop.
 *
 * We test the pure helper `buildTrendReport` directly rather than
 * spawning a child process so the tests stay fast and hermetic.
 */
import { describe, it, expect } from 'vitest';
import { buildTrendReport } from '../../../../.github/scripts/voice-quality-trend-report';
import type { Layer2Report } from '../../src/ai/voice-quality/report-layer2';

function syntheticReport(overrides: {
  overallPassRate: number;
  ttfaP95Ms?: number;
  perceivedCompletionRate?: number;
  totalCostCents?: number;
  flakeCount?: number;
}): Layer2Report {
  const flakeIds: string[] = [];
  for (let i = 0; i < (overrides.flakeCount ?? 0); i++) flakeIds.push(`flake-${i}`);
  return {
    rubricVersion: 'v1',
    generatedAt: '2026-05-04T00:00:00.000Z',
    totalScripts: 14,
    totalPassedAggregate: Math.round(overrides.overallPassRate * 14),
    overallPassRate: overrides.overallPassRate,
    perScriptVerdicts: [],
    callerExperience: {
      ttfaMedians: { p50: 400, p95: overrides.ttfaP95Ms ?? 700 },
      lookupMedians: { p50: 200, p95: 400 },
      repromptRatioOverall: 0.05,
      perceivedCompletionRate: overrides.perceivedCompletionRate ?? 0.95,
    },
    cost: {
      totalCents: overrides.totalCostCents ?? 700,
      perScriptAverageCents: 50,
      perBucket: {},
    },
    flakes: flakeIds,
    costCapped: [],
    launchGate: {
      pass: true,
      blockers: [],
      thresholds: {
        floorAllScripts: true,
        overallPassRateMin: 0.85,
        ttfaP95MaxMs: 800,
        perceivedCompletionPassRateMin: 0.9,
        costCappedScriptsMax: 0,
      },
      measured: {
        floorAllPass: true,
        overallPassRate: overrides.overallPassRate,
        ttfaP95Ms: overrides.ttfaP95Ms ?? 700,
        perceivedCompletionPassRate: overrides.perceivedCompletionRate ?? 0.95,
        costCappedScripts: 0,
      },
    },
  };
}

describe('VQ2-017 — trend report builder', () => {
  it('VQ2-017 — trend report builds with no prior: regressionDetected=false, notes contain "baseline"', () => {
    const current = syntheticReport({ overallPassRate: 0.92 });
    const trend = buildTrendReport(current, null);
    expect(trend.regressionDetected).toBe(false);
    expect(trend.prior).toBeUndefined();
    expect(trend.deltas).toBeUndefined();
    expect(trend.notes.join(' ').toLowerCase()).toContain('baseline');
    expect(trend.currentRun.overallPassRate).toBeCloseTo(0.92);
  });

  it('VQ2-017 — trend report with prior + 4pp drop: regressionDetected=false (under 5pp threshold)', () => {
    const prior = syntheticReport({ overallPassRate: 0.96 });
    const current = syntheticReport({ overallPassRate: 0.92 });
    const trend = buildTrendReport(current, prior);
    expect(trend.regressionDetected).toBe(false);
    expect(trend.deltas).toBeDefined();
    expect(trend.deltas!.overallPassRatePct).toBeCloseTo(-4, 5);
  });

  it('VQ2-017 — trend report with prior + 6pp drop: regressionDetected=true, notes mention drop', () => {
    const prior = syntheticReport({ overallPassRate: 0.96 });
    const current = syntheticReport({ overallPassRate: 0.9 });
    const trend = buildTrendReport(current, prior);
    expect(trend.regressionDetected).toBe(true);
    expect(trend.deltas!.overallPassRatePct).toBeCloseTo(-6, 5);
    expect(trend.notes.join(' ').toLowerCase()).toMatch(/drop|dropped/);
  });
});
