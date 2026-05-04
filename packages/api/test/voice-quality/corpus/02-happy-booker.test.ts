/**
 * VQ-011 — Bucket 02 happy-path booker corpus tests.
 *
 * Asserts that each of the four bucket-2 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (one entry per turn — `null` when the turn is a
 *      clarification with no proposal, otherwise the expected proposal
 *      payload),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges will be recorded later via
 *      `npm run voice-quality:record` once API access is available).
 *
 * Note on `spokenAnswerMatches`: the confirmation TTS strings emitted by
 * the existing twilio-adapter for mutation proposals are not asserted
 * verbatim here. Without running the agent we are approximating the
 * phrasing the operator-facing readback will use; the criterion-12
 * LLM-judge in VQ-022 is intentionally lenient on phrasing and will
 * grade these scripts on semantic equivalence rather than exact match.
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
  'create-appointment-known-customer',
  'reschedule-appointment-known-customer',
  'cancel-appointment-known-customer',
  'two-step-booking-known-customer',
] as const;

describe('VQ-011 — Bucket 02 happy booker', () => {
  it.each(SCRIPT_IDS)(
    'VQ-011 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '02-happy-booker',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('02-happy-booker');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-011 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      // Bucket 2 mutations always emit a proposal, so the golden array
      // is non-empty. The two-step-booking script's first turn is a
      // clarification (no proposal → `null` entry), so we only assert
      // the array is parsed; per-turn shape is enforced by the
      // structured grader at run time.
      expect(Array.isArray(golden)).toBe(true);
      expect((golden as unknown[]).length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-011 — cassette stub for %s is valid JSON with empty entries',
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
      expect(parsed.entries).toEqual([]);
    },
  );
});
