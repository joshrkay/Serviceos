/**
 * VQ-010 — Bucket 01 happy-path lookups corpus tests.
 *
 * Asserts that each of the six bucket-1 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty is fine — pure lookups produce no proposals;
 *      caller-facing answer is graded by criterion 12 LLM-judge),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges will be recorded later via
 *      `npm run voice-quality:record` once API access is available).
 *
 * The corpus root is the canonical source-tree location so these
 * scripts also load through `loadCorpus()` for the runner.
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
  'lookup-account-summary-known-customer',
  'lookup-customer-confirm-info',
  'lookup-jobs-known-customer',
  'lookup-appointments-next',
  'lookup-invoices-balance',
  'lookup-estimates-recent',
] as const;

describe('VQ-010 — Bucket 01 happy lookups', () => {
  it.each(SCRIPT_IDS)(
    'VQ-010 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '01-happy-lookups',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('01-happy-lookups');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-010 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      // Empty array (typical for pure lookups: no proposals) or undefined
      // (file absent) both acceptable here. We assert it's a valid JSON
      // array since we DID author the file.
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-010 — cassette stub for %s is valid JSON with empty entries',
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
