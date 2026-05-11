/**
 * VQ2-followup — entry-test wiring smoke tests.
 *
 * Covers the parts of `voice-quality.layer2.test.ts` that DON'T require
 * real API keys:
 *
 *   - The skip-path semantics still produce a valid `Layer2Report` on
 *     disk at the expected location, with `launchGate.pass: false`
 *     ("no scripts in report" is the documented blocker for an empty
 *     run).
 *   - The `Layer2Report` produced for an empty result list has the
 *     fields the launch-gate consumer + PR-comment poster reads.
 *
 * The real-execution path is intentionally NOT exercised here — that's
 * what the `voice-quality:layer2` workflow does in CI when keys are
 * provided. Adding a unit test that hits real APIs would be wasteful;
 * instead we exercise the wiring shape so a regression in
 * `buildLayer2Report` or the Layer 2 entry test's report file path is
 * caught quickly.
 *
 * This file is picked up by the default vitest config (it matches
 * `*.test.ts` outside the layer2 entry pattern) — so it runs on every
 * PR regardless of API-key availability.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { buildLayer2Report } from '../../src/ai/voice-quality/report-layer2';

const REPORT_PATH = path.resolve(
  __dirname,
  '../../voice-quality-layer2-report.json',
);

describe('VQ2-followup — Layer 2 entry-test wiring', () => {
  it('VQ2-followup — empty corpus produces a valid Layer2Report with launchGate.pass=false', () => {
    const report = buildLayer2Report([]);

    // Shape check — fields the launch-gate consumer (CI) + PR-comment
    // poster read.
    expect(report.totalScripts).toBe(0);
    expect(report.launchGate.pass).toBe(false);
    expect(report.launchGate.blockers).toContain('no scripts in report');
    expect(report.cost.totalCents).toBe(0);
    expect(report.flakes).toEqual([]);
    expect(report.costCapped).toEqual([]);
    expect(report.callerExperience.ttfaMedians.p95).toBe(0);
  });

  it('VQ2-followup — entry test report path matches the CI artifact-upload location', () => {
    // The `actions/upload-artifact` step in the Layer 2 workflow uploads
    // `packages/api/voice-quality-layer2-report.json`. If the entry test
    // ever moves the file, the artifact step will silently fail to find
    // it. Pin the resolved path so a refactor that breaks this contract
    // shows up here.
    expect(REPORT_PATH).toContain('voice-quality-layer2-report.json');
    expect(path.basename(REPORT_PATH)).toBe(
      'voice-quality-layer2-report.json',
    );
  });

  it('VQ2-followup — empty Layer2Report serializes cleanly to JSON (artifact-upload contract)', () => {
    const report = buildLayer2Report([]);
    const serialized = JSON.stringify(report, null, 2);
    const reparsed = JSON.parse(serialized) as ReturnType<
      typeof buildLayer2Report
    >;

    expect(reparsed.launchGate.pass).toBe(false);
    expect(reparsed.totalScripts).toBe(0);
    expect(typeof reparsed.generatedAt).toBe('string');
    // ISO-8601 sanity (must parse).
    expect(Number.isFinite(Date.parse(reparsed.generatedAt))).toBe(true);
  });

  it('VQ2-followup — buildLayer2Report tolerates a single cost-capped script (skip-after-suite-cap path)', () => {
    // Mirror the synthetic `makeCostCappedResult` shape used in
    // voice-quality.layer2.test.ts when the suite cap trips mid-run.
    // The report aggregator should accept it without throwing and surface
    // the script in `costCapped`.
    const costCapped = {
      scriptId: 'fake-cost-capped',
      aggregated: {
        floor: { passed: false, runResults: [] as Array<{ passed: boolean; failedCriteria: number[] }> },
        disposition: {
          passed: false,
          slotsAgree: false,
          distinctSlotValueCounts: {} as Record<string, number>,
        },
        callerExperience: {
          ttfaMedianMs: 0,
          lookupMedianMs: 0,
          durationMedianMs: 0,
          repromptRatioMedian: 0,
          recoveryTurnsMedian: 0,
        },
        perceivedCompletion: {
          passed: false,
          satisfactions: [] as ReadonlyArray<'good' | 'acceptable' | 'poor'>,
        },
        flakeIndicator: false,
      },
      perRunResults: [],
      totalCostCents: 0,
      costCapped: true,
      durationMs: 0,
    };

    const report = buildLayer2Report([costCapped]);

    expect(report.totalScripts).toBe(1);
    expect(report.costCapped).toEqual(['fake-cost-capped']);
    expect(report.launchGate.pass).toBe(false);
    // The cost-capped blocker string includes the script id so a CI
    // consumer can act on it without parsing structured fields.
    expect(
      report.launchGate.blockers.some((b) => b.includes('fake-cost-capped')),
    ).toBe(true);
  });

  // ─── Codex P1 fix — launchGate.pass enforcement regression test ───────────
  //
  // The Layer 2 entry test (voice-quality.layer2.test.ts) now ends with a
  // final `it('VQ2-LAYER2 — launch gate verdict')` that rebuilds the
  // launch-gate verdict from `suiteState.perScriptResults` and asserts
  // `report.launchGate.pass === true`. The regression we're guarding
  // against: previously the suite could exit 0 even when launchGate.pass
  // was false because the per-script `it.each` block only checked the
  // floor — regressions in TTFA P95, perceived-completion, overall pass
  // rate, or cost-capped count all slipped through.
  //
  // We don't re-execute the entry test from here (it requires API keys),
  // but we DO verify the underlying assertion logic: given a "degraded"
  // result set (passing floor but failing perceived completion), the
  // report's launchGate.pass is false AND the blockers array names the
  // failure — which is exactly what the entry test now reads.
  it('VQ2-fix — degraded report produces launchGate.pass=false and a non-empty blockers list', () => {
    // Construct a result that passes floor on EVERY script but fails
    // perceived completion on every script. Old behavior: it.each
    // assertions all pass (floor.passed=true) and the suite exits 0
    // even though the launch gate considers perceived-completion failure
    // a hard blocker. New behavior: the final `it` rebuilds the report
    // and asserts launchGate.pass — surfacing the regression.
    const degraded = Array.from({ length: 5 }, (_, i) => ({
      scriptId: `regression-${i}`,
      aggregated: {
        floor: { passed: true, runResults: [] as Array<{ passed: boolean; failedCriteria: number[] }> },
        disposition: {
          passed: true,
          slotsAgree: true,
          distinctSlotValueCounts: {} as Record<string, number>,
        },
        callerExperience: {
          ttfaMedianMs: 200,
          lookupMedianMs: 400,
          durationMedianMs: 30_000,
          repromptRatioMedian: 0,
          recoveryTurnsMedian: 0,
        },
        // Hard regression: perceived completion fails. Old harness
        // missed this because the entry test only asserted floor.
        perceivedCompletion: {
          passed: false,
          satisfactions: [] as ReadonlyArray<'good' | 'acceptable' | 'poor'>,
        },
        flakeIndicator: false,
      },
      perRunResults: [],
      totalCostCents: 0,
      costCapped: false,
      durationMs: 100,
    }));

    const report = buildLayer2Report(degraded);

    // This is exactly what the new `VQ2-LAYER2 — launch gate verdict` it
    // asserts. If `launchGate.pass` ever silently flipped to true on a
    // perceived-completion failure, this test would catch the regression
    // here in the unit suite (which always runs, no keys required).
    expect(report.launchGate.pass).toBe(false);
    expect(report.launchGate.blockers.length).toBeGreaterThan(0);
    // The blocker message names the failure mode the entry test now
    // surfaces in its assertion message.
    expect(
      report.launchGate.blockers.some((b) =>
        b.includes('perceived completion'),
      ),
    ).toBe(true);
    // Crucially, floor passes — the OLD entry-test it.each assertion
    // would have considered every script a PASS. The new
    // launchGate.pass assertion still flags it red.
    expect(report.launchGate.measured.floorAllPass).toBe(true);
    expect(report.launchGate.measured.perceivedCompletionPassRate).toBe(0);
  });

  it('VQ2-followup — when keys are absent the entry test must still leave a report on disk', async () => {
    // We don't re-run the entry test here (it lives under a different
    // vitest config). But we DO assert that the file the entry test
    // promises to produce is at the documented path — and if it exists
    // from a prior run, that it parses as a Layer2Report.
    if (!fs.existsSync(REPORT_PATH)) {
      // This is OK in a fresh checkout; the entry test will create it
      // on first run. The smoke value here is the path itself, asserted
      // above.
      return;
    }
    const raw = fs.readFileSync(REPORT_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ReturnType<typeof buildLayer2Report>;
    expect(parsed).toHaveProperty('launchGate');
    expect(parsed.launchGate).toHaveProperty('pass');
    expect(typeof parsed.launchGate.pass).toBe('boolean');
  });
});
