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
 * create-customer-new-signup: bucket-03 script; disposition grading
 * depends on P18-001 classifier + persisted create_customer execution.
 * Cassettes must be recorded (Phase 2) before expecting launchGate pass.
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

  it('VQ-012 — create-customer-new-signup is documented as v1 known failure (P17-001)', () => {
    // Pin the grading config so the documented-known-failure stays
    // accurately documented. P17-001 will fix the `create_customer`
    // classifier branch; until it ships, criterion 9 (disposition
    // intent) is expected to fail on this single script. The launch
    // gate accommodates this with a per-script exemption on bucket 3.
    const file = path.join(
      CORPUS_ROOT,
      'scripts',
      '03-lead-capture',
      'create-customer-new-signup.json',
    );
    const script = loadScript(file);
    expect(script.grading.appliesFloor).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(script.grading.appliesDisposition).toEqual([9, 10, 11, 12]);
    // Layer 2 corpus selection drops this script until P17-001 lands.
    expect(script.layer2Eligible).toBe(false);
    // The script's expected intent is `create_customer`, which the
    // classifier currently maps to `unknown` (P17-001).
    expect(script.turns[0].expected.intent).toBe('create_customer');
  });
});
