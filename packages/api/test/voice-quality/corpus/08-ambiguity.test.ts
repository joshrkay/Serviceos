/**
 * VQ-017 — Bucket 08 ambiguity / reprompt corpus tests.
 *
 * Asserts that each of the four bucket-8 scripts:
 *   1. Parses through `VoiceQualityScriptSchema` (via `loadScript`),
 *   2. Has a sibling golden file under `corpus/golden/` that parses as
 *      a JSON array (empty for non-mutation scripts; the
 *      `partial-info-incomplete` script's turn-2 lands a
 *      `create_appointment` proposal so its golden is `[null, {...}]`),
 *   3. Has a placeholder cassette under `corpus/cassettes/` with empty
 *      `entries` (real LLM exchanges are recorded later via
 *      `npm run voice-quality:record`).
 *
 * Bucket 8 covers ambiguity / reprompt edges: utterances the agent
 * cannot confidently classify on the first attempt, where the correct
 * behavior is to reprompt the caller (or escalate) rather than fire
 * a low-confidence proposal.
 *
 * The four scripts:
 *  - `mumble-low-confidence-reprompt` — gibberish utterance ("uhh,
 *    wnsh") then a clean clarification ("I'd like to schedule").
 *  - `two-intents-one-sentence` — compound utterance combining a
 *    cancel + a rebook ("Cancel my Tuesday and rebook Wednesday at
 *    2pm"); agent should pick the dominant intent (reschedule) or
 *    escalate, never fire two proposals silently.
 *  - `partial-info-incomplete` — vague booking ("Book me for some
 *    time next week") then a specific time ("Tuesday at 2"); turn 1
 *    classifies but extracts nothing, turn 2 lands the proposal.
 *  - `accent-uncertain-confidence` — heavily-accented transcription
 *    ("Ah wud lyk ta scedool an apointmunt") then a yes/confirm; tests
 *    that the agent confirms understanding before classifying.
 *
 * RISK / CAVEAT — these scripts test the AGENT'S response to
 * whatever the classifier produces from the caller transcript as
 * given. They do NOT exercise real STT confidence scoring (which
 * would require Whisper to actually mis-transcribe audio). The
 * Layer-1 corpus is deliberately text-mode; STT confidence and
 * audio-input behavior are Layer 2's concern. We simulate
 * "low-confidence transcription" via plain text strings (gibberish,
 * compound sentences, vague phrasing, accented spellings), which is
 * a stretch — but it lets the rubric grade the agent's
 * reprompt/escalate behavior even before the STT layer exists.
 *
 * `layer2Eligible` is `false` for the whole bucket — these are edges,
 * not happy-path caller-experience scripts. (The Layer-2 plan does
 * promote one mumble + one accent script into a Layer-2 ambiguity
 * sub-bucket; that's a future concern handled at promotion time, not
 * here.)
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
  'mumble-low-confidence-reprompt',
  'two-intents-one-sentence',
  'partial-info-incomplete',
  'accent-uncertain-confidence',
] as const;

describe('VQ-017 — Bucket 08 ambiguity / reprompt', () => {
  it.each(SCRIPT_IDS)(
    'VQ-017 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '08-ambiguity',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('08-ambiguity');
      // Bucket-8 invariant: each script is a 2-turn exchange (caller's
      // initial low-confidence utterance + caller's clarification after
      // the agent reprompts).
      expect(script.turns.length).toBe(2);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
      expect(script.callerIdBlocked).toBe(false);
      // Bucket-8 invariant: edges are excluded from the Layer-2
      // caller-experience corpus.
      expect(script.layer2Eligible).toBe(false);
      // Bucket-8 invariant: floors 1-5 are always in scope (PII,
      // auto-mutation, hang, cost cap, tenant leak).
      expect(script.grading.appliesFloor).toEqual([1, 2, 3, 4, 5]);
      expect(script.grading.appliesDisposition).toEqual([9, 11, 12]);
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-017 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
      if (scriptId === 'partial-info-incomplete') {
        // Turn 1 reprompts (no proposal); turn 2 lands a
        // create_appointment proposal once the slot is provided.
        expect(golden).toHaveLength(2);
        expect(golden[0]).toBeNull();
        expect(golden[1]).toMatchObject({
          proposalType: 'create_appointment',
        });
      } else {
        // The other three scripts are non-mutation paths — the agent
        // reprompts or escalates without drafting any proposal.
        expect(golden).toEqual([]);
      }
    },
  );

  it.each(SCRIPT_IDS)(
    'VQ-017 — cassette stub for %s is valid JSON with empty entries',
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

/**
 * VQ2-014 — Bucket 08 audio-only scripts.
 *
 * Two scripts that exercise failure modes Layer 1 cassettes cannot
 * fairly grade — Whisper-only mishearing (mumbled name) and the
 * end-of-speech detector (mid-sentence pause). Both are flagged
 * `layer2Eligible: true, layer2Only: true` so the Layer 1 corpus
 * runner skips them but the Layer 2 runner picks them up.
 */
const VQ2_014_SCRIPT_IDS = [
  'mumbled-name-recovery',
  'mid-sentence-pause',
] as const;

describe('VQ2-014 — Bucket 08 audio-only Layer-2 scripts', () => {
  it.each(VQ2_014_SCRIPT_IDS)(
    'VQ2-014 — script %s parses + loads',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '08-ambiguity',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.id).toBe(scriptId);
      expect(script.bucket).toBe('08-ambiguity');
      // Single-turn audio-only scripts.
      expect(script.turns.length).toBe(1);
      expect(script.callerId).toMatch(/^\+1\d{10}$/);
      expect(script.callerIdBlocked).toBe(false);
    },
  );

  it.each(VQ2_014_SCRIPT_IDS)(
    'VQ2-014 — script %s has layer2Eligible: true',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '08-ambiguity',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.layer2Eligible).toBe(true);
    },
  );

  it.each(VQ2_014_SCRIPT_IDS)(
    'VQ2-014 — script %s has layer2Only: true',
    (scriptId) => {
      const file = path.join(
        CORPUS_ROOT,
        'scripts',
        '08-ambiguity',
        `${scriptId}.json`,
      );
      const script = loadScript(file);
      expect(script.layer2Only).toBe(true);
    },
  );

  it.each(VQ2_014_SCRIPT_IDS)(
    'VQ2-014 — golden file for %s exists and parses',
    (scriptId) => {
      const golden = loadGoldenForScript(scriptId, CORPUS_ROOT);
      expect(Array.isArray(golden)).toBe(true);
      if (scriptId === 'mid-sentence-pause') {
        // Booker turn lands a create_appointment proposal.
        expect(golden).toHaveLength(1);
        expect(golden[0]).toMatchObject({
          proposalType: 'create_appointment',
        });
      } else {
        // The mumbled-name lookup is a non-mutation path — the agent
        // identity-resolves and confirms; no proposal drafted.
        expect(golden).toEqual([]);
      }
    },
  );

  it.each(VQ2_014_SCRIPT_IDS)(
    'VQ2-014 — cassette stub for %s is valid JSON with empty entries',
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
