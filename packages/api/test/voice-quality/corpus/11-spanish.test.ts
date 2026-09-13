/**
 * UB-C4 — Bucket 11 Spanish streaming-path corpus tests.
 *
 * Asserts that each of the four bucket-11 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for lookups/escalations; the booking script
 *      carries a create_appointment proposal),
 *   3. Has a recorded cassette under `corpus/cassettes/` — EXCEPT
 *      `es-emergency-escalation`, which correctly has none (see below).
 *
 * Scenario coverage (per the UB-C plan):
 *   - es-booking-happy-path       — Spanish caller books an appointment.
 *   - es-first-utterance-switch   — call opens 'en', first Spanish final
 *                                   switches the session to 'es'.
 *   - es-explicit-switch-back-en  — Spanish call, explicit mid-call
 *                                   "switch to english" request.
 *   - es-emergency-escalation     — "fuga de gas" escalates with the
 *                                   Spanish 911 safety line.
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
  'es-booking-happy-path',
  'es-first-utterance-switch',
  'es-explicit-switch-back-en',
  'es-emergency-escalation',
] as const;

/** See the dedicated assertion below for why this one has no cassette. */
const ZERO_LLM_CALL_SCRIPT_ID = 'es-emergency-escalation';

describe('UB-C4 — Bucket 11 Spanish', () => {
  it.each(SCRIPT_IDS)(
    'UB-C4 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '11-spanish',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('11-spanish');
      expect(script.turns.length).toBeGreaterThanOrEqual(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
    },
  );

  it.each(SCRIPT_IDS)(
    'UB-C4 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
    },
  );

  it.each(SCRIPT_IDS.filter((id) => id !== ZERO_LLM_CALL_SCRIPT_ID))(
    'UB-C4 — cassette file for %s is valid JSON with recorded entries',
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
      expect(parsed.entries.length).toBeGreaterThan(0);
    },
  );

  // Review follow-up K1 (2026-08-09) — this script reaches its terminal
  // answer WITHOUT issuing a single LLM call: the "fuga de gas" utterance
  // trips the safety tier, which escalates before any classify call. Its
  // cassette had accumulated 27 entries from older taxonomies and not one
  // live one, so the 2026-08-09 `--prune` correctly reduced it to zero — at
  // which point `npm run voice-quality:check-cassettes` (a documented
  // pre-launch gate) went red on an EMPTY cassette while the corpus replay
  // suite stayed 73/73 with the file gone entirely.
  //
  // The right artifact for a zero-call script is NO FILE, not an empty one,
  // and this assertion is what keeps that true. If it ever fails because
  // the file came back, the script has started issuing LLM calls: remove it
  // from ZERO_LLM_CALL_SCRIPT_IDS in
  // scripts/check-voice-quality-cassettes.ts and flip this back to the
  // has-entries assertion above.
  it(`UB-C4 — ${ZERO_LLM_CALL_SCRIPT_ID} has NO cassette (it issues zero LLM calls)`, () => {
    const cassettePath = path.join(
      CORPUS_ROOT,
      'cassettes',
      `${ZERO_LLM_CALL_SCRIPT_ID}.json`,
    );
    expect(existsSync(cassettePath)).toBe(false);
  });

  it('UB-C4 — the booking golden carries the create_appointment proposal', () => {
    const golden = loadGoldenForScript('es-booking-happy-path', CORPUS_ROOT) as Array<{
      proposalType: string;
    }>;
    expect(golden).toHaveLength(1);
    expect(golden[0].proposalType).toBe('create_appointment');
  });

  it('UB-C4 — the explicit-switch script contains a language_switch turn', () => {
    const script = loadScript(
      path.join(CORPUS_ROOT, 'scripts', '11-spanish', 'es-explicit-switch-back-en.json'),
    );
    const switchTurn = script.turns.find(
      (t) => t.expected.intent === 'language_switch',
    );
    expect(switchTurn).toBeDefined();
  });

  it('UB-C4 — the emergency script escalates with the Spanish safety line', () => {
    const script = loadScript(
      path.join(CORPUS_ROOT, 'scripts', '11-spanish', 'es-emergency-escalation.json'),
    );
    expect(script.turns[0].expected.escalates).toBe(true);
    expect(script.turns[0].expected.spokenAnswerMatches).toContain('911');
  });
});
