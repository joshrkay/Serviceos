/**
 * VQ-016 — Bucket 07 out-of-scope-escalation corpus tests.
 *
 * Asserts that each of the four bucket-7 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for these scripts — every turn intentionally
 *      requests an MVP-out-of-scope action so the agent must escalate
 *      rather than draft a proposal),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * Bucket 7 exercises disposition criterion 11 (`escalation`): every
 * script asks the agent to do something the MVP does not implement
 * (`record_payment`, `update_customer`, `add_note`) or that is too
 * vague to classify. The expected behavior is to hand the call off
 * to a human, not to guess. `expected.escalates: true` and a missing
 * `proposalType` encode that intent.
 *
 * `layer2Eligible` is `false` for the whole bucket — Layer 2's
 * caller-experience suite focuses on graceful end-to-end exchanges,
 * not deliberate escalation cases.
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
  'payment-request-escalated',
  'update-customer-escalated',
  'add-note-escalated',
  'vague-complaint-escalated',
] as const;

describe('VQ-016 — Bucket 07 out-of-scope escalation', () => {
  it.each(SCRIPT_IDS)(
    'VQ-016 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '07-out-of-scope',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('07-out-of-scope');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
      // Bucket-7 invariant: every turn must explicitly escalate. The
      // agent should never guess at MVP-out-of-scope intents.
      for (const turn of script.turns) {
        expect(turn.expected.escalates).toBe(true);
        expect(turn.expected.proposalType).toBeUndefined();
      }
      // Bucket-7 invariant: out-of-scope scripts are not part of the
      // caller-experience Layer 2 corpus.
      expect(script.layer2Eligible).toBe(false);
      // Bucket-7 invariant: disposition criterion 11 (escalation) is
      // always in scope for this bucket, alongside intent (9) and
      // caller-facing answer (12).
      expect(script.grading.appliesDisposition).toContain(11);
      expect(script.grading.appliesDisposition).toContain(9);
      expect(script.grading.appliesDisposition).toContain(12);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-016 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      // Out-of-scope escalations should produce no proposals — the
      // agent's only legal move is to hand off to a human. Empty
      // golden array is the correct expectation here.
      expect(Array.isArray(golden)).toBe(true);
      expect(golden).toEqual([]);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-016 — cassette file for %s is valid JSON (entries filled after seed/record)',
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
