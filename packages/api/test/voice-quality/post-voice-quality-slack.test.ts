/**
 * VQ2-017 — Slack poster integration tests.
 *
 * Pins the contract for `.github/scripts/post-voice-quality-slack.ts`:
 *
 *   - On a null report, the body announces "produced no report".
 *   - On a green report, the body contains the pass count, TTFA P95 and
 *     total cost.
 *   - When trend deltas are present, the body shows signed week-over-week
 *     deltas for pass rate, TTFA, cost.
 *   - When the report has flakes, the count is surfaced.
 *
 * We test the pure helper `buildSlackBody` directly rather than spawning
 * a child process or hitting a real webhook.
 */
import { describe, it, expect } from 'vitest';
import { buildSlackBody } from '../../../../.github/scripts/post-voice-quality-slack';
import type { Layer2Report } from '../../src/ai/voice-quality/report-layer2';

function greenReport(overrides: Partial<Layer2Report> = {}): Layer2Report {
  const base: Layer2Report = {
    rubricVersion: 'v1',
    generatedAt: '2026-05-04T00:00:00.000Z',
    totalScripts: 14,
    totalPassedAggregate: 13,
    overallPassRate: 13 / 14,
    perScriptVerdicts: [],
    callerExperience: {
      ttfaMedians: { p50: 400, p95: 720 },
      lookupMedians: { p50: 200, p95: 400 },
      repromptRatioOverall: 0.05,
      perceivedCompletionRate: 0.93,
    },
    cost: {
      totalCents: 740,
      perScriptAverageCents: 53,
      perBucket: {},
    },
    flakes: [],
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
        overallPassRate: 13 / 14,
        ttfaP95Ms: 720,
        perceivedCompletionPassRate: 0.93,
        costCappedScripts: 0,
      },
    },
  };
  return { ...base, ...overrides };
}

describe('VQ2-017 — Slack body builder', () => {
  it('VQ2-017 — buildSlackBody on null report returns "produced no report" string', () => {
    const body = buildSlackBody(null, null);
    expect(body.toLowerCase()).toContain('produced no report');
  });

  it('VQ2-017 — buildSlackBody on green report contains pass count + TTFA + cost', () => {
    const body = buildSlackBody(greenReport(), null);
    expect(body).toContain('13/14');
    // TTFA P95 of 720ms should appear (rounded).
    expect(body).toMatch(/720\s*ms/);
    // Cost $7.40 should appear.
    expect(body).toContain('$7.40');
  });

  it('VQ2-017 — buildSlackBody with trend deltas shows WoW signed deltas', () => {
    const trend = {
      generatedAt: '2026-05-04T00:00:00.000Z',
      currentRun: {
        overallPassRate: 13 / 14,
        ttfaP95Ms: 720,
        perceivedCompletionRate: 0.93,
        totalCostCents: 740,
        flakeCount: 0,
      },
      prior: {
        overallPassRate: 14 / 14,
        ttfaP95Ms: 750,
        perceivedCompletionRate: 0.95,
        totalCostCents: 720,
        flakeCount: 0,
      },
      deltas: {
        overallPassRatePct: ((13 / 14) - 1) * 100, // ~-7.1
        ttfaP95DeltaMs: -30,
        perceivedCompletionPct: -2,
        costDeltaCents: 20,
      },
      regressionDetected: true,
      notes: ['Pass rate dropped 7.1pp WoW'],
    };
    const body = buildSlackBody(greenReport(), trend);
    // Signed pp delta — must be negative and visible.
    expect(body).toMatch(/-7\.1pp|-7\.\d+pp/);
    // TTFA delta -30ms.
    expect(body).toMatch(/-30\s*ms/);
    // Cost delta +$0.20.
    expect(body).toMatch(/\+\$0\.20/);
  });

  it('VQ2-017 — buildSlackBody surfaces flakes count when > 0', () => {
    const body = buildSlackBody(
      greenReport({ flakes: ['lookup-invoices', 'edge-case-3'] }),
      null,
    );
    expect(body.toLowerCase()).toContain('flake');
    expect(body).toContain('2');
  });
});
