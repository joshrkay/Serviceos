/**
 * VQ2-015 — Layer 2 report aggregator + launch-gate tests.
 *
 * The Layer 2 report wraps Layer 1's per-script grader rollup with the
 * voting-aware verdict produced by VQ2-013's `RunScriptLayer2Result`.
 * These tests synthesize fixtures (no I/O, no real runner) and pin:
 *   - launch-gate semantics from the Layer 2 plan §VQ2-015
 *   - threshold table per the plan's "Caller-experience thresholds" §
 *   - markdown formatting (PASS/FAIL marker + blocker bullets)
 *   - JSON-schema shape: `voice-quality-layer2-report.schema.json` is
 *     valid JSON and lists the keys we serialize.
 *   - top-level `launchGate.pass: boolean` so the existing PR-comment
 *     poster keeps working without a Layer 2 codepath.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunScriptLayer2Result } from '../../src/ai/voice-quality/runner-layer2';
import type { AggregatedResult } from '../../src/ai/voice-quality/voting/majority-vote';
import {
  buildLayer2Report,
  formatLayer2ReportMarkdown,
  DEFAULT_LAYER2_THRESHOLDS,
  type Layer2Report,
  type Layer2LaunchGateThresholds,
} from '../../src/ai/voice-quality/report-layer2';

// ─── Fixture builders ─────────────────────────────────────────────────────────

interface FixtureOpts {
  scriptId?: string;
  floorPassed?: boolean;
  dispositionPassed?: boolean;
  perceivedPassed?: boolean;
  ttfaMedianMs?: number;
  lookupMedianMs?: number;
  repromptRatioMedian?: number;
  flakeIndicator?: boolean;
  costCapped?: boolean;
  totalCostCents?: number;
  durationMs?: number;
}

function fixtureAggregated(opts: FixtureOpts): AggregatedResult {
  return {
    floor: {
      passed: opts.floorPassed ?? true,
      runResults: [
        { passed: opts.floorPassed ?? true, failedCriteria: [] },
        { passed: opts.floorPassed ?? true, failedCriteria: [] },
        { passed: opts.floorPassed ?? true, failedCriteria: [] },
      ],
    },
    disposition: {
      passed: opts.dispositionPassed ?? true,
      slotsAgree: true,
      distinctSlotValueCounts: {},
    },
    callerExperience: {
      ttfaMedianMs: opts.ttfaMedianMs ?? 500,
      lookupMedianMs: opts.lookupMedianMs ?? 1500,
      durationMedianMs: 5000,
      repromptRatioMedian: opts.repromptRatioMedian ?? 0.05,
      recoveryTurnsMedian: 1,
    },
    perceivedCompletion: {
      passed: opts.perceivedPassed ?? true,
      satisfactions: ['good', 'good', 'good'],
    },
    flakeIndicator: opts.flakeIndicator ?? false,
  };
}

function fixtureRun(opts: FixtureOpts = {}): RunScriptLayer2Result {
  const aggregated = fixtureAggregated(opts);
  return {
    scriptId: opts.scriptId ?? 'stub-script',
    aggregated,
    perRunResults: [
      // Empty per-run details are fine — the report does not consume them.
      // Cast to PerRunResult shape via a structural object.
      {
        floor: { passed: aggregated.floor.passed, failedCriteria: [] },
        disposition: { passed: aggregated.disposition.passed, failedCriteria: [], slotValues: {} },
        callerExperience: {
          ttfaMs: aggregated.callerExperience.ttfaMedianMs,
          lookupMs: aggregated.callerExperience.lookupMedianMs,
          durationMs: aggregated.callerExperience.durationMedianMs,
          repromptRatio: aggregated.callerExperience.repromptRatioMedian,
          recoveryTurns: aggregated.callerExperience.recoveryTurnsMedian,
        },
        perceivedCompletion: { satisfaction: 'good', abandonmentRisk: 0 },
      },
      {
        floor: { passed: aggregated.floor.passed, failedCriteria: [] },
        disposition: { passed: aggregated.disposition.passed, failedCriteria: [], slotValues: {} },
        callerExperience: {
          ttfaMs: aggregated.callerExperience.ttfaMedianMs,
          lookupMs: aggregated.callerExperience.lookupMedianMs,
          durationMs: aggregated.callerExperience.durationMedianMs,
          repromptRatio: aggregated.callerExperience.repromptRatioMedian,
          recoveryTurns: aggregated.callerExperience.recoveryTurnsMedian,
        },
        perceivedCompletion: { satisfaction: 'good', abandonmentRisk: 0 },
      },
      {
        floor: { passed: aggregated.floor.passed, failedCriteria: [] },
        disposition: { passed: aggregated.disposition.passed, failedCriteria: [], slotValues: {} },
        callerExperience: {
          ttfaMs: aggregated.callerExperience.ttfaMedianMs,
          lookupMs: aggregated.callerExperience.lookupMedianMs,
          durationMs: aggregated.callerExperience.durationMedianMs,
          repromptRatio: aggregated.callerExperience.repromptRatioMedian,
          recoveryTurns: aggregated.callerExperience.recoveryTurnsMedian,
        },
        perceivedCompletion: { satisfaction: 'good', abandonmentRisk: 0 },
      },
    ],
    totalCostCents: opts.totalCostCents ?? 200,
    costCapped: opts.costCapped ?? false,
    durationMs: opts.durationMs ?? 5000,
  };
}

function fixtureSuite(count: number, opts: (i: number) => FixtureOpts = () => ({})): RunScriptLayer2Result[] {
  return Array.from({ length: count }, (_, i) =>
    fixtureRun({ scriptId: `script-${String(i + 1).padStart(2, '0')}`, ...opts(i) }),
  );
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('VQ2-015 — Layer 2 report aggregator', () => {
  it('VQ2-015 — empty results: launchGate.pass=false, totalScripts=0', () => {
    const r = buildLayer2Report([]);
    expect(r.totalScripts).toBe(0);
    expect(r.totalPassedAggregate).toBe(0);
    expect(r.overallPassRate).toBe(0);
    expect(r.launchGate.pass).toBe(false);
    // Floor "every" of empty array is vacuously true, but an empty corpus
    // should not be a passing launch gate. Implementation must surface a
    // blocker for this case.
    expect(r.launchGate.blockers.length).toBeGreaterThan(0);
  });

  it('VQ2-015 — 14 scripts all pass: launchGate.pass=true', () => {
    const results = fixtureSuite(14);
    const r = buildLayer2Report(results);
    expect(r.totalScripts).toBe(14);
    expect(r.totalPassedAggregate).toBe(14);
    expect(r.overallPassRate).toBe(1);
    expect(r.launchGate.pass).toBe(true);
    expect(r.launchGate.blockers).toEqual([]);
    expect(r.launchGate.measured.floorAllPass).toBe(true);
    expect(r.launchGate.measured.costCappedScripts).toBe(0);
  });

  it('VQ2-015 — 1 floor failure: launchGate.pass=false with floor blocker citing scriptId', () => {
    const results = fixtureSuite(14, (i) => (i === 7 ? { floorPassed: false } : {}));
    const r = buildLayer2Report(results);
    expect(r.launchGate.pass).toBe(false);
    expect(r.launchGate.measured.floorAllPass).toBe(false);
    const floorBlocker = r.launchGate.blockers.find((b) => b.toLowerCase().includes('floor'));
    expect(floorBlocker).toBeDefined();
    expect(floorBlocker).toContain('script-08');
  });

  it('VQ2-015 — overall pass rate 12/14 (≥85%): pass; 11/14 (<85%): fail', () => {
    // 12/14 pass, 2 disposition failures (no floor failures so rate threshold is the gate).
    const ok = fixtureSuite(14, (i) => (i < 2 ? { dispositionPassed: false } : {}));
    const okReport = buildLayer2Report(ok);
    expect(okReport.overallPassRate).toBeCloseTo(12 / 14, 5);
    // 12/14 is ~0.857 ≥ 0.85, so the rate threshold is met. Still need to
    // confirm no other blocker fires from this fixture.
    const rateBlocker = okReport.launchGate.blockers.find((b) =>
      b.toLowerCase().includes('overall pass rate'),
    );
    expect(rateBlocker).toBeUndefined();

    // 11/14 = 0.786 < 0.85
    const bad = fixtureSuite(14, (i) => (i < 3 ? { dispositionPassed: false } : {}));
    const badReport = buildLayer2Report(bad);
    expect(badReport.overallPassRate).toBeCloseTo(11 / 14, 5);
    expect(badReport.launchGate.pass).toBe(false);
    const badRateBlocker = badReport.launchGate.blockers.find((b) =>
      b.toLowerCase().includes('overall pass rate'),
    );
    expect(badRateBlocker).toBeDefined();
  });

  it('VQ2-015 — TTFA P95 = 850ms (>800): blocker; 800ms exactly: pass (inclusive)', () => {
    // P95 of 14 samples: floor((95/100) * 13) = 12, so the 13th sorted index.
    const high = fixtureSuite(14, (i) => ({ ttfaMedianMs: i >= 12 ? 850 : 500 }));
    const highReport = buildLayer2Report(high);
    const blocker = highReport.launchGate.blockers.find((b) => b.includes('TTFA'));
    expect(blocker).toBeDefined();
    expect(highReport.launchGate.pass).toBe(false);

    const exact = fixtureSuite(14, (i) => ({ ttfaMedianMs: i >= 12 ? 800 : 500 }));
    const exactReport = buildLayer2Report(exact);
    const blockerExact = exactReport.launchGate.blockers.find((b) => b.includes('TTFA'));
    expect(blockerExact).toBeUndefined();
    expect(exactReport.launchGate.pass).toBe(true);
  });

  it('VQ2-015 — perceived completion 13/14 (~93%): pass; 12/14 (~85.7%): fail', () => {
    // 13/14 pass, 1 fail = ~93% > 90%
    const ok = fixtureSuite(14, (i) => (i === 0 ? { perceivedPassed: false, dispositionPassed: false } : {}));
    // dispositionPassed false makes overall 13/14 = 92.8% ≥ 85% (still passes overall).
    const okReport = buildLayer2Report(ok);
    const pcBlockerOk = okReport.launchGate.blockers.find((b) =>
      b.toLowerCase().includes('perceived'),
    );
    expect(pcBlockerOk).toBeUndefined();

    // 12/14 perceived pass = 85.7% < 90%
    const bad = fixtureSuite(14, (i) =>
      i < 2 ? { perceivedPassed: false, dispositionPassed: false } : {},
    );
    const badReport = buildLayer2Report(bad);
    const pcBlocker = badReport.launchGate.blockers.find((b) =>
      b.toLowerCase().includes('perceived'),
    );
    expect(pcBlocker).toBeDefined();
    expect(badReport.launchGate.pass).toBe(false);
  });

  it('VQ2-015 — cost-capped scripts > 0: blocker', () => {
    const results = fixtureSuite(14, (i) => (i === 5 ? { costCapped: true } : {}));
    const r = buildLayer2Report(results);
    expect(r.costCapped).toEqual(['script-06']);
    expect(r.launchGate.measured.costCappedScripts).toBe(1);
    const blocker = r.launchGate.blockers.find((b) => b.toLowerCase().includes('cost-capped'));
    expect(blocker).toBeDefined();
    expect(blocker).toContain('script-06');
    expect(r.launchGate.pass).toBe(false);
  });

  it('VQ2-015 — flakes are surfaced in report.flakes from aggregated.flakeIndicator', () => {
    const results = fixtureSuite(14, (i) => (i === 3 || i === 9 ? { flakeIndicator: true } : {}));
    const r = buildLayer2Report(results);
    expect(r.flakes).toEqual(['script-04', 'script-10']);
  });

  it('VQ2-015 — cost totals + per-script average', () => {
    const results = fixtureSuite(14, () => ({ totalCostCents: 100 }));
    const r = buildLayer2Report(results);
    expect(r.cost.totalCents).toBe(1400);
    expect(r.cost.perScriptAverageCents).toBe(100);
  });

  it('VQ2-015 — formatLayer2ReportMarkdown contains PASS marker on green report', () => {
    const r = buildLayer2Report(fixtureSuite(14));
    const md = formatLayer2ReportMarkdown(r);
    expect(md).toContain('PASS');
    expect(md).toContain('Voice Quality Layer 2 Report');
    expect(md).toContain('14/14');
  });

  it('VQ2-015 — formatLayer2ReportMarkdown contains FAIL marker + blocker bullets on red report', () => {
    const results = fixtureSuite(14, (i) => (i === 0 ? { floorPassed: false } : {}));
    const r = buildLayer2Report(results);
    const md = formatLayer2ReportMarkdown(r);
    expect(md).toContain('FAIL');
    expect(md).toContain('## Blockers');
    // Blocker bullets are rendered as "- <reason>"
    expect(md.match(/^- floor/m)).toBeTruthy();
  });

  it('VQ2-015 — top-level launchGate.pass is a boolean (PR-comment compat)', () => {
    const r = buildLayer2Report(fixtureSuite(14));
    // The PR-comment poster reads `report.launchGate.pass` — pin this contract.
    expect(typeof r.launchGate.pass).toBe('boolean');
    // Also pin the shape so the schema test below can rely on it.
    const top = r as unknown as Record<string, unknown>;
    expect(Object.keys(top)).toContain('launchGate');
  });

  it('VQ2-015 — custom thresholds override defaults', () => {
    const tighter: Layer2LaunchGateThresholds = {
      ...DEFAULT_LAYER2_THRESHOLDS,
      ttfaP95MaxMs: 400,
    };
    const results = fixtureSuite(14, () => ({ ttfaMedianMs: 500 }));
    const r = buildLayer2Report(results, tighter);
    expect(r.launchGate.pass).toBe(false);
    expect(r.launchGate.thresholds.ttfaP95MaxMs).toBe(400);
  });

  it('VQ2-015 — DEFAULT_LAYER2_THRESHOLDS match plan §"Caller-experience thresholds"', () => {
    expect(DEFAULT_LAYER2_THRESHOLDS.floorAllScripts).toBe(true);
    expect(DEFAULT_LAYER2_THRESHOLDS.overallPassRateMin).toBe(0.85);
    expect(DEFAULT_LAYER2_THRESHOLDS.ttfaP95MaxMs).toBe(800);
    expect(DEFAULT_LAYER2_THRESHOLDS.perceivedCompletionPassRateMin).toBe(0.9);
    expect(DEFAULT_LAYER2_THRESHOLDS.costCappedScriptsMax).toBe(0);
  });

  it('VQ2-015 — per-script verdicts include scriptId, costCapped, totalCostCents, durationMs', () => {
    const results = fixtureSuite(2, (i) => ({ totalCostCents: i === 0 ? 100 : 200, durationMs: i === 0 ? 1000 : 2000 }));
    const r = buildLayer2Report(results);
    expect(r.perScriptVerdicts).toHaveLength(2);
    expect(r.perScriptVerdicts[0]).toMatchObject({
      scriptId: 'script-01',
      costCapped: false,
      totalCostCents: 100,
      durationMs: 1000,
    });
    expect(r.perScriptVerdicts[1].totalCostCents).toBe(200);
  });
});

// ─── Schema validation ────────────────────────────────────────────────────────

describe('VQ2-015 — schema.json', () => {
  const schemaPath = join(__dirname, '..', '..', 'voice-quality-layer2-report.schema.json');

  it('VQ2-015 — schema.json is valid JSON', () => {
    const raw = readFileSync(schemaPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const schema = JSON.parse(raw);
    expect(schema.$schema).toBeDefined();
    expect(schema.title).toBe('Layer2Report');
    expect(schema.type).toBe('object');
  });

  it('VQ2-015 — schema lists every top-level key emitted by buildLayer2Report', () => {
    const raw = readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(raw) as { required?: string[]; properties?: Record<string, unknown> };
    const sample = buildLayer2Report(fixtureSuite(1));
    const sampleKeys = Object.keys(sample);
    for (const k of sampleKeys) {
      expect(schema.properties).toHaveProperty(k);
    }
    // Hard-required keys per the contract (PR-comment poster relies on launchGate).
    expect(schema.required).toContain('launchGate');
    expect(schema.required).toContain('rubricVersion');
    expect(schema.required).toContain('totalScripts');
  });

  it('VQ2-015 — schema validates a sample report shape (key presence)', () => {
    const sample: Layer2Report = buildLayer2Report(fixtureSuite(3));
    // Lightweight structural check: top-level required keys are all present.
    expect(sample.rubricVersion).toBeTypeOf('string');
    expect(sample.generatedAt).toBeTypeOf('string');
    expect(sample.totalScripts).toBe(3);
    expect(sample.launchGate.pass).toBeTypeOf('boolean');
    expect(Array.isArray(sample.launchGate.blockers)).toBe(true);
    expect(sample.launchGate.measured).toBeTypeOf('object');
    expect(sample.launchGate.thresholds).toBeTypeOf('object');
    expect(Array.isArray(sample.perScriptVerdicts)).toBe(true);
    expect(Array.isArray(sample.flakes)).toBe(true);
    expect(Array.isArray(sample.costCapped)).toBe(true);
  });
});
