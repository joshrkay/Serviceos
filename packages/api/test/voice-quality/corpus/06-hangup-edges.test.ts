/**
 * VQ-015 — Bucket 06 hangup-edges corpus tests.
 *
 * Asserts that each of the three bucket-6 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (one entry per turn — `null` when the turn does
 *      not result in a proposal, or a proposal payload when the agent
 *      drafted one before the hangup),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * Bucket 6 exercises floor criterion 8 (`hangupHandled`): every script
 * sets `hangupAfter: true` on its final turn so the runner calls
 * `driver.hangup()` immediately after the caller speaks. The grader
 * then asserts the session is `terminated` and no `pending` proposal
 * leaked through.
 *
 * `layer2Eligible` is `false` for the whole bucket — Layer 2's
 * caller-experience suite focuses on graceful exchanges, not abrupt
 * disconnects.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { loadScript } from '../../../src/ai/voice-quality/corpus/loader';
import { loadGoldenForScript } from '../../../src/ai/voice-quality/graders/disposition-structured';

const CORPUS_ROOT = path.resolve(
  __dirname,
  '../../../src/ai/voice-quality/corpus',
);

const SCRIPT_IDS = [
  'hangup-mid-confirmation',
  'hangup-before-intent',
  'hangup-post-proposal',
] as const;

describe('VQ-015 — Bucket 06 hangup edges', () => {
  it.each(SCRIPT_IDS)(
    'VQ-015 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '06-hangup-edges',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('06-hangup-edges');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
      // Bucket-6 invariant: the final turn must trigger a hangup so
      // the runner exercises the `hangupHandled` floor criterion.
      const lastTurn = script.turns[script.turns.length - 1];
      expect(lastTurn.hangupAfter).toBe(true);
      // Bucket-6 invariant: hangup scripts are not part of the
      // caller-experience Layer 2 corpus.
      expect(script.layer2Eligible).toBe(false);
      // Bucket-6 invariant: floor criterion 8 (hangupHandled) is
      // always in scope for this bucket.
      expect(script.grading.appliesFloor).toContain(8);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-015 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-015 — cassette file for %s is valid JSON (entries filled after seed/record)',
    (scriptId) => {
      const cassettePath = path.join(
        CORPUS_ROOT,
        'cassettes',
        `${scriptId}.json`,
      );
      const raw = readFileSync(cassettePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.scriptId).toBe(scriptId);
      expect(parsed.version).toBe(1);
      expect(parsed.rubricVersion).toBe('v1');
      expect(Array.isArray(parsed.entries)).toBe(true);
    },
  );
});
