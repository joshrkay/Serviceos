/**
 * VQ-L1-entry — Layer 1 launch-gate wiring smoke tests.
 *
 * Mirrors `voice-quality.layer2.entry.test.ts` for the Layer 1 report
 * aggregator (`aggregate` in graders/report.ts). Exercises paths that
 * do NOT require `ANTHROPIC_API_KEY` so launch-gate enforcement is
 * testable on every PR.
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { aggregate } from '../../src/ai/voice-quality/graders/report';

const REPORT_PATH = path.resolve(__dirname, '../../voice-quality-report.json');

describe('VQ-L1-entry — Layer 1 launch-gate wiring', () => {
  it('VQ-L1-entry — empty corpus produces launchGate.pass=false with no-scripts blocker', () => {
    const report = aggregate([]);

    expect(report.totalScripts).toBe(0);
    expect(report.launchGate.pass).toBe(false);
    // Empty verdicts: only the explicit empty-corpus blocker (see report.ts).
    expect(report.launchGate.blockers).toContain('no scripts in report');
    expect(report.meetsOverallThreshold).toBe(false);
  });

  it('VQ-L1-entry — VoiceQualityReport serializes with launchGate.pass field', () => {
    const report = aggregate([]);
    const serialized = JSON.stringify(report, null, 2);
    const reparsed = JSON.parse(serialized) as ReturnType<typeof aggregate>;

    expect(reparsed.launchGate.pass).toBe(false);
    expect(reparsed.totalScripts).toBe(0);
    expect(typeof reparsed.generatedAt).toBe('string');
    expect(Number.isFinite(Date.parse(reparsed.generatedAt))).toBe(true);
  });

  it('VQ-L1-entry — entry test report path matches the CI artifact-upload location', () => {
    // `actions/upload-artifact` in pr-checks.yml uploads
    // `packages/api/voice-quality-report.json`.
    expect(REPORT_PATH).toContain('voice-quality-report.json');
    expect(path.basename(REPORT_PATH)).toBe('voice-quality-report.json');
  });
});
