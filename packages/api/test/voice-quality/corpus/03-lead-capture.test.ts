/**
 * VQ-012 — Bucket 03 lead-capture corpus tests.
 *
 * Asserts that each of the three bucket-3 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for scripts where the agent should not
 *      propose anything; populated for scripts that should propose
 *      `create_customer` etc.),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * P18-001 closed the `create-customer-new-signup` classifier leak; the script
 * is Layer-2 eligible and must classify `create_customer` on the signup
 * phrasing. The caller turn includes a name; hard-slot grading only pins
 * caller-id `phone` (name is a soft slot for VQ-022). Cassettes must still
 * be recorded (Phase 2) before expecting Layer 1 `launchGate.pass`.
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
  'find-or-create-lead-unknown-caller',
  'create-customer-new-signup',
  'known-customer-no-signup',
] as const;

describe('VQ-012 — Bucket 03 lead capture', () => {
  it.each(SCRIPT_IDS)(
    'VQ-012 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '03-lead-capture',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('03-lead-capture');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-012 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-012 — cassette stub for %s is valid JSON with empty entries',
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

  it('VQ-012 — create-customer-new-signup is P18-001-ready (layer2 + create_customer intent)', () => {
    // P18-001: classifier + voice handler shipped. Cassettes must still be
    // recorded (Phase 2) before Layer 1 launch gate can pass in replay mode.
    const file = path.join(
      CORPUS_ROOT,
      'scripts',
      '03-lead-capture',
      'create-customer-new-signup.json',
    );
    const script = loadScript(file);
    expect(script.grading.appliesFloor).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(script.grading.appliesDisposition).toEqual([9, 10, 11, 12]);
    expect(script.layer2Eligible).toBe(true);
    expect(script.turns[0].expected.intent).toBe('create_customer');
    expect(script.turns[0].expected.proposalType).toBe('create_customer');

    const golden = loadGoldenForScript(script.id, CORPUS_ROOT);
    expect(golden).toEqual([{ phone: '+15555550302' }]);
  });
});
