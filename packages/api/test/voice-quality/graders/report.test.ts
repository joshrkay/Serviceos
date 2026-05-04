/**
 * VQ-023 — Report aggregator tests.
 *
 * Exercises the per-script -> per-bucket -> overall rollup, the launch-gate
 * verdict (floor failure short-circuits regardless of pass rate), the
 * P50/P95 latency math (including single-sample / empty edge cases), and
 * the Markdown formatter's determinism.
 *
 * Tests build synthetic `PerScriptVerdict` arrays directly so they don't
 * depend on running the actual corpus.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregate,
  formatReportMarkdown,
  type PerScriptVerdict,
} from '../../../src/ai/voice-quality/graders/report';
import type { FloorResult } from '../../../src/ai/voice-quality/graders/floor';
import type { DispositionStructuredResult } from '../../../src/ai/voice-quality/graders/disposition-structured';

function makeFloor(passed: boolean, failedCriteria: number[] = []): FloorResult {
  return {
    passed,
    failedCriteria,
    reasons: failedCriteria.reduce<Record<number, string>>((acc, id) => {
      acc[id] = `criterion ${id} failed`;
      return acc;
    }, {}),
  };
}

function makeStructured(passed: boolean): DispositionStructuredResult {
  return {
    passed,
    failedCriteria: passed ? [] : [9],
    reasons: passed ? {} : { 9: 'intent mismatch' },
    perTurnDetail: [],
  };
}

function makeVerdict(partial: Partial<PerScriptVerdict>): PerScriptVerdict {
  return {
    scriptId: partial.scriptId ?? 'script-x',
    bucket: partial.bucket ?? '01-happy-lookups',
    passed: partial.passed ?? true,
    floorResult: partial.floorResult ?? makeFloor(true),
    dispositionStructuredResult:
      partial.dispositionStructuredResult ?? makeStructured(true),
    ...(partial.dispositionLlmResult !== undefined
      ? { dispositionLlmResult: partial.dispositionLlmResult }
      : {}),
    durationMs: partial.durationMs ?? 1000,
    costCents: partial.costCents ?? 5,
    perTurnLatencyMs: partial.perTurnLatencyMs ?? [100, 200],
  };
}

describe('VQ-023 — report aggregator', () => {
  it('VQ-023 — aggregate produces correct overall pass rate', () => {
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({ scriptId: 's1', bucket: '04-identity-edges', passed: true }),
      makeVerdict({ scriptId: 's2', bucket: '04-identity-edges', passed: true }),
      makeVerdict({ scriptId: 's3', bucket: '04-identity-edges', passed: false, dispositionStructuredResult: makeStructured(false) }),
      makeVerdict({ scriptId: 's4', bucket: '04-identity-edges', passed: false, dispositionStructuredResult: makeStructured(false) }),
    ];
    const report = aggregate(verdicts);
    expect(report.totalScripts).toBe(4);
    expect(report.totalPassed).toBe(2);
    expect(report.overallPassRate).toBeCloseTo(0.5, 6);
    expect(report.meetsOverallThreshold).toBe(false);
    expect(report.overallThreshold).toBe(0.9);
  });

  it('VQ-023 — aggregate computes per-bucket pass rates correctly', () => {
    const verdicts: PerScriptVerdict[] = [
      // 01-happy-lookups: 2/2 pass
      makeVerdict({ scriptId: 'h1', bucket: '01-happy-lookups', passed: true }),
      makeVerdict({ scriptId: 'h2', bucket: '01-happy-lookups', passed: true }),
      // 04-identity-edges: 1/2 pass (50%)
      makeVerdict({ scriptId: 'e1', bucket: '04-identity-edges', passed: true }),
      makeVerdict({ scriptId: 'e2', bucket: '04-identity-edges', passed: false, dispositionStructuredResult: makeStructured(false) }),
    ];
    const report = aggregate(verdicts);
    const happy = report.perBucket.find((b) => b.bucket === '01-happy-lookups');
    const edges = report.perBucket.find((b) => b.bucket === '04-identity-edges');
    expect(happy?.passRate).toBe(1.0);
    expect(happy?.scriptCount).toBe(2);
    expect(happy?.passCount).toBe(2);
    expect(edges?.passRate).toBeCloseTo(0.5, 6);
    expect(edges?.scriptCount).toBe(2);
    expect(edges?.passCount).toBe(1);
  });

  it('VQ-023 — aggregate marks meetsThreshold per bucket against the threshold table', () => {
    const verdicts: PerScriptVerdict[] = [
      // happy = 100% required, give 100%
      makeVerdict({ scriptId: 'h1', bucket: '01-happy-lookups', passed: true }),
      // identity-edges = 90%, give 90% via 9/10
      ...Array.from({ length: 9 }, (_, i) =>
        makeVerdict({ scriptId: `e${i}`, bucket: '04-identity-edges', passed: true }),
      ),
      makeVerdict({ scriptId: 'e9', bucket: '04-identity-edges', passed: false, dispositionStructuredResult: makeStructured(false) }),
      // adversarial = 70%, give 60% via 3/5 (fails)
      makeVerdict({ scriptId: 'a1', bucket: '10-adversarial', passed: true }),
      makeVerdict({ scriptId: 'a2', bucket: '10-adversarial', passed: true }),
      makeVerdict({ scriptId: 'a3', bucket: '10-adversarial', passed: true }),
      makeVerdict({ scriptId: 'a4', bucket: '10-adversarial', passed: false, dispositionStructuredResult: makeStructured(false) }),
      makeVerdict({ scriptId: 'a5', bucket: '10-adversarial', passed: false, dispositionStructuredResult: makeStructured(false) }),
    ];
    const report = aggregate(verdicts);
    const happy = report.perBucket.find((b) => b.bucket === '01-happy-lookups');
    const edges = report.perBucket.find((b) => b.bucket === '04-identity-edges');
    const adv = report.perBucket.find((b) => b.bucket === '10-adversarial');
    expect(happy?.threshold).toBe(1.0);
    expect(happy?.meetsThreshold).toBe(true);
    expect(edges?.threshold).toBe(0.9);
    expect(edges?.meetsThreshold).toBe(true); // 9/10 = 0.9 exactly
    expect(adv?.threshold).toBe(0.7);
    expect(adv?.meetsThreshold).toBe(false); // 3/5 = 0.6 < 0.7
  });

  it('VQ-023 — launchGate.pass is false when any floor failure exists, even if overall pass rate ≥ 90%', () => {
    // 19 passing + 1 floor-failing → overall = 95% but floor breaks gate.
    const verdicts: PerScriptVerdict[] = [
      ...Array.from({ length: 19 }, (_, i) =>
        makeVerdict({ scriptId: `pass-${i}`, bucket: '04-identity-edges', passed: true }),
      ),
      makeVerdict({
        scriptId: 'floor-fail',
        bucket: '04-identity-edges',
        passed: false,
        floorResult: makeFloor(false, [3]),
        dispositionStructuredResult: makeStructured(false),
      }),
    ];
    const report = aggregate(verdicts);
    expect(report.overallPassRate).toBeCloseTo(0.95, 6);
    expect(report.meetsOverallThreshold).toBe(true);
    expect(report.launchGate.pass).toBe(false);
  });

  it('VQ-023 — launchGate.blockers lists floor-failing scripts by ID', () => {
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({ scriptId: 'good', bucket: '01-happy-lookups', passed: true }),
      makeVerdict({
        scriptId: 'bad-floor-A',
        bucket: '06-hangup-edges',
        passed: false,
        floorResult: makeFloor(false, [8]),
        dispositionStructuredResult: makeStructured(false),
      }),
      makeVerdict({
        scriptId: 'bad-floor-B',
        bucket: '07-out-of-scope',
        passed: false,
        floorResult: makeFloor(false, [1]),
        dispositionStructuredResult: makeStructured(false),
      }),
    ];
    const report = aggregate(verdicts);
    expect(report.launchGate.pass).toBe(false);
    expect(report.launchGate.blockers.some((b) => b.includes('bad-floor-A'))).toBe(true);
    expect(report.launchGate.blockers.some((b) => b.includes('bad-floor-B'))).toBe(true);
    expect(report.launchGate.blockers.some((b) => b.includes('good'))).toBe(false);
  });

  it('VQ-023 — launchGate.blockers lists buckets failing their threshold', () => {
    const verdicts: PerScriptVerdict[] = [
      // 09-concurrency: 1/2 pass = 50%, threshold is 70%
      makeVerdict({ scriptId: 'c1', bucket: '09-concurrency', passed: true }),
      makeVerdict({
        scriptId: 'c2',
        bucket: '09-concurrency',
        passed: false,
        dispositionStructuredResult: makeStructured(false),
      }),
    ];
    const report = aggregate(verdicts);
    expect(report.launchGate.pass).toBe(false);
    const concurrencyBlocker = report.launchGate.blockers.find((b) =>
      b.includes('09-concurrency'),
    );
    expect(concurrencyBlocker).toBeDefined();
    expect(concurrencyBlocker).toContain('0.50');
    expect(concurrencyBlocker).toContain('0.70');
  });

  it('VQ-023 — costSummary.totalCents sums all script costs', () => {
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({ scriptId: 's1', bucket: '01-happy-lookups', costCents: 10 }),
      makeVerdict({ scriptId: 's2', bucket: '01-happy-lookups', costCents: 15 }),
      makeVerdict({ scriptId: 's3', bucket: '04-identity-edges', costCents: 25 }),
    ];
    const report = aggregate(verdicts);
    expect(report.costSummary.totalCents).toBe(50);
    expect(report.costSummary.perBucketAverageCents['01-happy-lookups']).toBe(12.5);
    expect(report.costSummary.perBucketAverageCents['04-identity-edges']).toBe(25);
  });

  it('VQ-023 — latencySummary computes P50 / P95 correctly across all turn samples', () => {
    // 20 samples, evenly spread 100..2000ms
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({
        scriptId: 's1',
        bucket: '01-happy-lookups',
        perTurnLatencyMs: samples.slice(0, 10),
      }),
      makeVerdict({
        scriptId: 's2',
        bucket: '01-happy-lookups',
        perTurnLatencyMs: samples.slice(10),
      }),
    ];
    const report = aggregate(verdicts);
    // Sorted: [100, 200, ..., 2000]; P50 idx = floor(0.5 * 19) = 9 → samples[9] = 1000
    expect(report.latencySummary.p50Ms).toBe(1000);
    // P95 idx = floor(0.95 * 19) = 18 → samples[18] = 1900
    expect(report.latencySummary.p95Ms).toBe(1900);
    expect(report.latencySummary.perBucketP95Ms['01-happy-lookups']).toBe(1900);
  });

  it('VQ-023 — formatReportMarkdown produces a non-empty Markdown string with overall %, bucket table, failed-scripts list', () => {
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({ scriptId: 'good', bucket: '01-happy-lookups', passed: true }),
      makeVerdict({
        scriptId: 'bad',
        bucket: '04-identity-edges',
        passed: false,
        dispositionStructuredResult: makeStructured(false),
      }),
    ];
    const report = aggregate(verdicts);
    const md = formatReportMarkdown(report);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain('Overall');
    expect(md).toContain('01-happy-lookups');
    expect(md).toContain('04-identity-edges');
    expect(md).toContain('bad'); // failed script id
    expect(md).toMatch(/\|/); // contains a Markdown table
  });

  it('VQ-023 — formatReportMarkdown is deterministic (same input → same output)', () => {
    const verdicts: PerScriptVerdict[] = [
      makeVerdict({ scriptId: 'a', bucket: '01-happy-lookups', passed: true }),
      makeVerdict({ scriptId: 'b', bucket: '04-identity-edges', passed: true }),
    ];
    const report1 = aggregate(verdicts);
    const report2 = aggregate(verdicts);
    // Pin generatedAt so two reports produced from the same input yield
    // the same Markdown — formatReportMarkdown is the deterministic
    // surface; aggregate stamps a timestamp which we normalize here.
    const fixed = '2026-05-04T00:00:00.000Z';
    const md1 = formatReportMarkdown({ ...report1, generatedAt: fixed });
    const md2 = formatReportMarkdown({ ...report2, generatedAt: fixed });
    expect(md1).toBe(md2);
  });

  it('VQ-023 — empty verdicts produces sensible defaults (overallPassRate: 0, etc., not NaN)', () => {
    const report = aggregate([]);
    expect(report.totalScripts).toBe(0);
    expect(report.totalPassed).toBe(0);
    expect(report.overallPassRate).toBe(0);
    expect(Number.isFinite(report.overallPassRate)).toBe(true);
    expect(report.meetsOverallThreshold).toBe(false);
    expect(report.perBucket).toEqual([]);
    expect(report.perScript).toEqual([]);
    expect(report.costSummary.totalCents).toBe(0);
    expect(Number.isFinite(report.latencySummary.p50Ms)).toBe(true);
    expect(Number.isFinite(report.latencySummary.p95Ms)).toBe(true);
    expect(report.latencySummary.p50Ms).toBe(0);
    expect(report.latencySummary.p95Ms).toBe(0);
    expect(report.launchGate.pass).toBe(false);
  });
});
