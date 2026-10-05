/**
 * #1587 — the Layer 1 simulator grades PRODUCTION code, not itself.
 *
 * `text-mode-driver.ts` used to carry its own identity / spam / after-hours /
 * stale-appointment gates (escalation reasons that existed in zero production
 * files), its own proposal-confirmation copy, and a mutation path through the
 * voice-action-router that the phone never takes. Scripts passed against code
 * no caller could reach, which is how #1552 broke Deploy for two days.
 *
 * This guard fails the build if the driver grows any of that back:
 *   - a turn-decision branch of its own (`kind: 'escalate'`, an `evaluateTurn`),
 *   - a mutation path that bypasses `speechTurn` (voice-action-router import,
 *     a `createProposal` call),
 *   - a caller-facing sentence literal. Spoken copy comes from the production
 *     processor's side effects (rendered through tts-copy); the driver speaks
 *     nothing of its own. A "sentence" is any string literal of three or more
 *     words carrying sentence punctuation — ids, event names and prefixes are
 *     one or two tokens and never end in a period.
 *
 * Evidence class: STRUCTURAL (the negative control plants each kind of drift
 * into a temp copy and shows the guard reporting it).
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { readFileSync } from 'fs';
// #1601 — the scanner is shared with spoken-copy.structural.test.ts, which
// extends this guard to the voice files whose copy lives in tts-copy.ts.
import { stripComments, stringLiterals, isSpokenCopy } from './spoken-copy-scan';

export { isSpokenCopy };

const DRIVER_PATH = path.resolve(
  __dirname,
  '../../src/ai/voice-quality/text-mode-driver.ts',
);

export interface DriverDriftReport {
  escalateBranches: number;
  evaluateTurn: boolean;
  actionRouterImport: boolean;
  createProposalCall: boolean;
  spokenCopy: string[];
}

export function scanDriverSource(source: string): DriverDriftReport {
  const code = stripComments(source);
  return {
    escalateBranches: (code.match(/kind:\s*['"]escalate['"]/g) ?? []).length,
    evaluateTurn: /\bevaluateTurn\b/.test(code),
    actionRouterImport: /workers\/voice-action-router/.test(code),
    createProposalCall: /\bcreateProposal\s*\(/.test(code),
    spokenCopy: stringLiterals(code).filter(isSpokenCopy),
  };
}

function expectClean(report: DriverDriftReport): void {
  expect(report.escalateBranches, 'driver decides escalation itself').toBe(0);
  expect(report.evaluateTurn, 'driver carries its own turn evaluation').toBe(false);
  expect(report.actionRouterImport, 'driver drafts through voice-action-router').toBe(false);
  expect(report.createProposalCall, 'driver persists a proposal of its own').toBe(false);
  expect(report.spokenCopy, 'driver speaks copy of its own').toEqual([]);
}

describe('#1587 — text-mode-driver.ts has no gate logic and no spoken copy of its own', () => {
  const source = readFileSync(DRIVER_PATH, 'utf8');

  it('the driver only drives the production processor', () => {
    expectClean(scanDriverSource(source));
  });

  it('negative control — the guard reports each kind of drift when planted', () => {
    const planted =
      source +
      `\nconst drift = { kind: 'escalate' as const };\n` +
      `function evaluateTurn(): void { /* planted */ }\n` +
      `import { createVoiceActionRouterWorker } from '../../workers/voice-action-router';\n` +
      `const p = createProposal({});\n` +
      `const line = "Got it — I've drafted a callback for review. Anything else?";\n`;
    const report = scanDriverSource(planted);
    expect(report.escalateBranches).toBeGreaterThan(0);
    expect(report.evaluateTurn).toBe(true);
    expect(report.actionRouterImport).toBe(true);
    expect(report.createProposalCall).toBe(true);
    expect(report.spokenCopy).toContain(
      "Got it — I've drafted a callback for review. Anything else?",
    );
  });

  it('isSpokenCopy keeps ids, event names and prefixes out of the report', () => {
    for (const ok of ['TEXT_MODE_', 'voice-event', 'system:text-mode', 'vq-owner:', 'tts_play']) {
      expect(isSpokenCopy(ok), ok).toBe(false);
    }
    expect(isSpokenCopy('This call has ended.')).toBe(true);
    expect(isSpokenCopy('Could you say that again?')).toBe(true);
  });
});
