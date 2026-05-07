/**
 * VQ-018 — Bucket 09 concurrency / state-edge corpus tests.
 *
 * Asserts that each of the three bucket-9 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` (empty array
 *      for scripts where the agent should refuse / escalate; populated
 *      with a single proposal for the slot-conflict script where the
 *      agent does propose — just to the wrong slot),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * Bucket 9 is intentionally where v1 will fail at first — the three
 * scripts here document known concurrency hazards in dispatch
 * (design doc §1.5 / §5.2) the rubric must surface:
 *   - `stale-appointment-just-cancelled`: agent doesn't re-check
 *     appointment status mid-call after a cancellation event lands.
 *   - `slot-just-taken-by-other-call`: no concurrent-write protection
 *     when two calls compete for the same slot.
 *   - `customer-just-archived-mid-call`: cached customer state isn't
 *     re-checked when an archival event lands during the call.
 *
 * The launch gate accommodates these expected failures via the 70%
 * adversarial-bucket threshold (spec §7.2). A fourth assertion below
 * pins the grading shape so the documented-known-failure stays
 * accurately documented — a future fix that flips an expected failure
 * to passing must update this test deliberately rather than silently
 * change scope.
 *
 * `layer2Eligible` is `false` for the whole bucket — Layer 2 caller
 * experience tests run against a clean corpus, not pre-broken state.
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
  'stale-appointment-just-cancelled',
  'slot-just-taken-by-other-call',
  'customer-just-archived-mid-call',
] as const;

describe('VQ-018 — Bucket 09 concurrency edges', () => {
  it.each(SCRIPT_IDS)(
    'VQ-018 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '09-concurrency',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('09-concurrency');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.turns.length).toBeLessThanOrEqual(2);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
      // Bucket-9 invariant: not part of the Layer 2 caller-experience
      // corpus — these scripts intentionally start from broken state.
      expect(script.layer2Eligible).toBe(false);
      // Bucket-9 invariant: floors 1-6 in scope (no compliance/hangup).
      expect(script.grading.appliesFloor).toEqual([1, 2, 3, 4, 5, 6]);
      expect(script.grading.appliesDisposition).toEqual([9, 10, 11, 12]);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-018 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-018 — cassette stub for %s is valid JSON with empty entries',
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

  it('VQ-018 — scripts are documented v1 known-failures (concurrency hazards)', () => {
    // Pin the per-script grading + escalation shape so the
    // documented-known-failure stays accurately documented. Future
    // concurrency stories that fix one of these gaps must flip the
    // matching expectation here intentionally rather than silently
    // change scope.
    const expectations: Record<
      (typeof SCRIPT_IDS)[number],
      { intent: string; escalates: boolean }
    > = {
      // Stale state: appointment was cancelled 30s before the call;
      // agent should detect cancellation, not silently propose a
      // reschedule. Today: agent doesn't re-check status mid-call.
      'stale-appointment-just-cancelled': {
        intent: 'reschedule_appointment',
        escalates: true,
      },
      // Concurrent write: slot Tuesday-2pm was just taken by another
      // call; agent should detect conflict and propose alternative.
      // Today: no concurrent-write protection — proposal goes to the
      // wrong slot. `escalates: false` because a (wrong) proposal is
      // still produced.
      'slot-just-taken-by-other-call': {
        intent: 'create_appointment',
        escalates: false,
      },
      // Cached state: customer was archived 10s before the call;
      // agent should refuse or escalate. Today: cached state isn't
      // re-checked — agent serves the archived customer.
      'customer-just-archived-mid-call': {
        intent: 'lookup_account_summary',
        escalates: true,
      },
    };

    for (const scriptId of SCRIPT_IDS) {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '09-concurrency',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      // Floors 1-6 in scope: tenant + duplicate emphasis (no
      // compliance/hangup criteria for bucket 9).
      expect(script.grading.appliesFloor).toEqual([1, 2, 3, 4, 5, 6]);
      expect(script.grading.appliesDisposition).toEqual([9, 10, 11, 12]);
      expect(script.layer2Eligible).toBe(false);
      // The first-turn intent + escalation shape is the contract this
      // bucket pins. Future fixes that flip these must update this
      // test deliberately.
      const firstTurn = script.turns[0];
      expect(firstTurn.expected.intent).toBe(expectations[scriptId].intent);
      expect(firstTurn.expected.escalates).toBe(
        expectations[scriptId].escalates,
      );
    }
  });
});
