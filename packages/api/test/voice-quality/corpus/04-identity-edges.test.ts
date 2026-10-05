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
import { existsSync, readFileSync } from 'fs';
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

/** #1587 — scripts the production engine answers before any model call; see the dedicated assertion below. */
const ZERO_LLM_CALL_SCRIPT_IDS = [
  'caller-id-blocked',
  'caller-id-matches-multiple-customers',
  'caller-id-mismatched-but-claims-existing',
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

  it.each(SCRIPT_IDS.filter((id) => !(ZERO_LLM_CALL_SCRIPT_IDS as readonly string[]).includes(id)))(
    'VQ-013 — cassette file for %s is valid JSON (entries filled after seed/record)',
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

  // #1587 — identity turns the production engine resolves before any model call: a
  // blocked or ambiguous caller-ID is asked for name + address and then handed
  // off; a caller claiming to be an existing customer from another number is
  // handed off at ask_caller (the #1587 port). No turn reaches the classifier.
  // The right artifact for a zero-call script is NO cassette file (an empty
  // one fails `npm run voice-quality:check-cassettes`); the ids are declared
  // in ZERO_LLM_CALL_SCRIPT_IDS in scripts/check-voice-quality-cassettes.ts,
  // which fails the moment one of them records a call again.
  it.each(ZERO_LLM_CALL_SCRIPT_IDS)('VQ-013 — %s has NO cassette (it issues zero LLM calls)', (scriptId) => {
    const cassettePath = path.join(CORPUS_ROOT, 'cassettes', `${scriptId}.json`);
    expect(existsSync(cassettePath)).toBe(false);
  });
});
