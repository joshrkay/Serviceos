/**
 * VQ-013 — Bucket 04 identity-resolution edges corpus tests.
 *
 * Asserts that each of the five bucket-4 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for these scripts — they test floor #6
 *      `noDuplicateCustomer` and identity-resolution boundary cases,
 *      none of which should produce mutating proposals),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * Bucket 4 is the floor #6 (`noDuplicateCustomer`) territory. Each
 * script intentionally varies caller-id matching against the
 * customers fixture to surface identity-resolution edges:
 *  - one match (resolve cleanly),
 *  - multiple matches (clarify or escalate),
 *  - blocked / private number (must ask for callback),
 *  - mismatched number with claimed-existing-name (must verify, not
 *    auto-resolve),
 *  - caller is an existing lead, not a customer (recognize, do not
 *    duplicate as a new lead).
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
  'caller-id-matches-one-customer',
  'caller-id-matches-multiple-customers',
  'caller-id-blocked',
  'caller-id-mismatched-but-claims-existing',
  'caller-id-matches-existing-lead-not-customer',
] as const;

describe('VQ-013 — Bucket 04 identity edges', () => {
  it.each(SCRIPT_IDS)(
    'VQ-013 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '04-identity-edges',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('04-identity-edges');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      // Floor #6 is the bucket's reason-for-being.
      expect(script.grading.appliesFloor).toContain(6);
      // Edge bucket: excluded from Layer 2 per the Layer 2 plan.
      expect(script.layer2Eligible).toBe(false);
      // Caller id is a North American E.164 except for the blocked
      // script, where it's intentionally null + callerIdBlocked=true.
      if (scriptId === 'caller-id-blocked') {
        expect(script.callerId).toBeNull();
        expect(script.callerIdBlocked).toBe(true);
      } else {
        expect(script.callerId).toMatch(/^\+1\d{10}$/);
        expect(script.callerIdBlocked).toBe(false);
      }
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-013 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      // Identity-resolution edges should produce no mutating proposals
      // — floor #6 fails the moment a duplicate is created. Empty
      // golden array is the correct expectation here.
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-013 — cassette stub for %s is valid JSON with empty entries',
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
