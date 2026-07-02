/**
 * UB-C4 — Bucket 11 Spanish streaming-path corpus tests.
 *
 * Asserts that each of the four bucket-11 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for lookups/escalations; the booking script
 *      carries a create_appointment proposal),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges will be recorded later via
 *      `npm run voice-quality:record` once API access is available —
 *      the same landing pattern buckets 01-10 used).
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
import { readFileSync } from 'fs';
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

  it.each(SCRIPT_IDS)(
    'UB-C4 — cassette file for %s is valid JSON (entries filled after seed/record)',
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
