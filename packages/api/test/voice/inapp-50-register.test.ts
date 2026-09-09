/**
 * The in-app 50-case gate.
 *
 * Runs the whole register (`fixtures/voice/inapp-50-cases.json`) through the
 * REAL in-app voice pipeline — `InAppVoiceAdapter` → `transitions.ts` →
 * `resolveSchedulingEntities` → `buildVoiceProposalPayload` → the proposal
 * repository, plus the shared lookup dispatch — with only the LLM scripted,
 * and asserts the plan's three release rules
 * (docs/plans/2026-09-09-inapp-50-cases-plan.md §Gates).
 *
 * Hermetic: no Postgres, no network, no provider. The whole run is one
 * `beforeAll` so the per-cluster `it`s below split ONE run into attributable
 * failures instead of re-driving 50 sessions eight times.
 *
 * Set `INAPP50_WRITE_RESULTS=1` to persist the run artifact + `latest.json`
 * under `docs/verification-runs/inapp-50/`.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { loadRegister, type Register } from '../../src/ai/voice-quality/inapp-50/register';
import { runRegister } from '../../src/ai/voice-quality/inapp-50/runner';
import {
  formatNonPassLines,
  formatScoreboard,
  writeRunArtifacts,
  type RunResult,
} from '../../src/ai/voice-quality/inapp-50/report';

const RUN_TIMEOUT_MS = 240_000;

// Loaded at collection time so the per-cluster `it`s below can be generated
// from the register's own cluster list.
const REGISTER = loadRegister();

describe('in-app 50-case register', () => {
  const register: Register = REGISTER;
  let result: RunResult;

  beforeAll(async () => {
    result = await runRegister(register);
    if (process.env.INAPP50_WRITE_RESULTS === '1') {
      const written = writeRunArtifacts(register, result);
      process.stdout.write(`\n${formatScoreboard(result, register.cases.length)}`);
      process.stdout.write(`wrote ${written.runPath}\nwrote ${written.latestPath}\n`);
    }
  }, RUN_TIMEOUT_MS);

  it('loads all fifty cases with unique ids and keys', () => {
    expect(register.cases).toHaveLength(50);
    expect(new Set(register.cases.map((c) => c.id)).size).toBe(50);
    expect(new Set(register.cases.map((c) => c.key)).size).toBe(50);
  });

  it('scores every case in the register', () => {
    expect(result.cases).toHaveLength(register.cases.length);
    expect(result.summary.total).toBe(register.cases.length);
  });

  it('passes the release gate (50/50, no critical intent_capture_only, no FAIL)', () => {
    const detail = [
      '',
      `PASS ${result.summary.PASS}/${result.summary.total}  ` +
        `PARTIAL ${result.summary.PARTIAL}  DEGRADED ${result.summary.DEGRADED}  ` +
        `FAIL ${result.summary.FAIL}`,
      '',
      'key | verdict | stage | rootCause.category | detail',
      ...formatNonPassLines(result),
      '',
      `gate reasons: ${result.summary.gate.reasons.join(' | ') || 'none'}`,
    ].join('\n');
    expect(result.summary.gate.pass, detail).toBe(true);
  });

  // One `it` per cluster so a failure names the cluster that owns the fix.
  for (const cluster of REGISTER.clusters) {
    it(`cluster '${cluster}' has no non-PASS case`, () => {
      const inCluster = result.cases.filter((c) => c.cluster === cluster);
      const nonPass = inCluster
        .filter((c) => c.verdict !== 'PASS')
        .map(
          (c) =>
            `${c.key} | ${c.verdict} | ${c.stage} | ${c.rootCause?.category ?? '-'} | ` +
            `${c.rootCause?.detail ?? c.reason}`,
        );
      expect(nonPass, `\n${nonPass.join('\n')}\n`).toEqual([]);
    });
  }

  it('mints no approve-to-fail proposal on any surface', () => {
    const violations = result.cases.flatMap((c) =>
      c.proposals
        .filter((p) => p.contractViolation)
        .map((p) => `${c.key}: ${p.contractViolation}`),
    );
    expect(violations, `\n${violations.join('\n\n')}\n`).toEqual([]);
  });
});
