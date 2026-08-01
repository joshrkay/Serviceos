/**
 * ANS-001 — caller-safety tier classification (S1 answering surface).
 *
 * Composes the deterministic `classifyUrgencyTier` engine with the
 * `detectEmergency` keyword backstop and maps the result onto the goal's
 * three safety tiers:
 *   E1 = TIER_1_EVACUATE       — life safety, evacuate, NEVER book
 *   E2 = TIER_2 / TIER_3       — urgent dispatch / same-day
 *   E3 = TIER_4_SCHEDULE       — routine
 *
 * The load-bearing rule (goal §3): "Any ambiguity resolves upward in tier —
 * always." On S1 a deterministic keyword hit may be UPGRADED to E1 but can
 * NEVER be downgraded below E2 by a false-positive guard.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import {
  loadTriageRulesFromFile,
  type TriageRules,
} from '../../../../src/ai/skills/triage-rules.schema';
import { classifyCallerSafety } from '../../../../src/ai/agents/customer-calling/emergency-tier';

const TRIAGE_RULES_PATH = resolve(
  __dirname,
  '../../../../../../corpus/data/triage-rules.json',
);

let rules: TriageRules;
beforeAll(() => {
  rules = loadTriageRulesFromFile(TRIAGE_RULES_PATH);
});

describe('classifyCallerSafety — E1 (life safety, never book)', () => {
  it.each([
    ['I smell gas in the basement', 'gas'],
    ['my carbon monoxide alarm is going off', 'carbon monoxide'],
    ['the electrical panel is sparking', 'electrical/sparking'],
    ['there is smoke coming from the vents', 'smoke'],
    ['the furnace is on fire', 'fire'],
    ['my husband collapsed and is not breathing', 'injury'],
    ['someone just got electrocuted by the outlet', 'injury/electrical'],
  ])('classifies %j as E1 (%s)', (utterance) => {
    const r = classifyCallerSafety(utterance, {}, rules);
    expect(r.tier).toBe('E1');
    expect(r.requiresEvacuation).toBe(true);
  });

  it('E1 carries a reviewed response script directing to safety', () => {
    const r = classifyCallerSafety('I smell gas', {}, rules);
    expect(r.responseScript).toBeTruthy();
    expect(r.responseScript ?? '').toMatch(/911|leave the building/i);
  });
});

describe('classifyCallerSafety — injury precision (present vs clearly-past)', () => {
  it.each([
    'my husband just collapsed and is not breathing',
    'someone collapsed, please help',
    'someone just got electrocuted',
    'my wife is having a seizure right now',
  ])('acute/ambiguous injury stays E1: %j', (utterance) => {
    expect(classifyCallerSafety(utterance, {}).tier).toBe('E1');
  });

  it.each([
    'the old shed collapsed years ago, I need a quote to rebuild',
    'I had a heart attack last year and want to schedule maintenance',
  ])('clearly-past injury report is NOT E1: %j', (utterance) => {
    expect(classifyCallerSafety(utterance, {}).tier).not.toBe('E1');
  });

  it('an acute hazard stays E1 even with past-tense framing (no tense disambiguation on hazards)', () => {
    // "there was a gas leak" — we do not risk a miss disambiguating tense on gas/fire.
    expect(classifyCallerSafety('there was a gas leak here a while back', {}).tier).toBe('E1');
  });
});

describe('classifyCallerSafety — E2 (urgent dispatch, never routine-booked)', () => {
  it.each([
    'my basement is flooding fast',
    'we have a burst pipe upstairs',
    'sewage is backing up into the house',
    'there is no hot water at all',
    'the AC is completely out',
  ])('classifies %j as E2', (utterance) => {
    const r = classifyCallerSafety(utterance, {}, rules);
    expect(r.tier).toBe('E2');
    expect(r.requiresEvacuation).toBe(false);
  });
});

describe('classifyCallerSafety — E3 (routine)', () => {
  it.each([
    'I want to book my annual AC tune-up',
    'can you send the estimate again',
    'my faucet drips a little',
  ])('classifies %j as E3', (utterance) => {
    const r = classifyCallerSafety(utterance, {}, rules);
    expect(r.tier).toBe('E3');
    expect(r.requiresEvacuation).toBe(false);
  });
});

describe('classifyCallerSafety — runtime hot path (NO rules / corpus not shipped)', () => {
  // The Docker runtime image ships only packages/api/dist — corpus/data is
  // absent. The embedded E1 table + detectEmergency backstop must classify
  // life safety WITHOUT the rich engine.
  it.each([
    'I smell gas in the basement',
    'the electrical panel is sparking',
    'there is smoke coming from the vents',
    'my husband collapsed and is not breathing',
    'someone just got electrocuted',
  ])('classifies %j as E1 with no rules loaded', (utterance) => {
    const r = classifyCallerSafety(utterance, {}); // no rules arg
    expect(r.tier).toBe('E1');
    expect(r.requiresEvacuation).toBe(true);
    expect(r.responseScript ?? '').toMatch(/911/);
  });

  it('still escalates keyword emergencies to at least E2 with no rules', () => {
    const r = classifyCallerSafety('the basement is flooding', {});
    expect(['E1', 'E2']).toContain(r.tier);
    expect(r.tier).not.toBe('E3');
  });

  it('classifies routine calls as E3 with no rules', () => {
    const r = classifyCallerSafety('I want to book my annual tune-up', {});
    expect(r.tier).toBe('E3');
  });
});

describe('corpus ↔ embedded parity (the runtime-authoritative table)', () => {
  // The corpus file is NOT shipped in the runtime image; the embedded table is
  // authoritative in production. This pin converts silent drift between the
  // two into a red CI run: every phrase a safety reviewer adds to the corpus
  // TIER_1 list must classify E1 in the RUNTIME configuration (no rules).
  it('every corpus TIER_1_EVACUATE phrase classifies E1 with NO rules loaded', () => {
    const misses = rules.trigger_words.TIER_1_EVACUATE.phrases.filter(
      (phrase) => classifyCallerSafety(phrase, {}).tier !== 'E1',
    );
    expect(misses).toEqual([]);
  });
});

describe('runtime E1 vocabulary — contractions, sparks-near, trade homonyms', () => {
  it.each([
    ["my husband isn't breathing", 'contraction the phrase table must match'],
    ['he is not breathing', 'uncontracted variant'],
    ["she won't wake up", 'unresponsive phrasing'],
    ['there are sparks near the water heater', 'sparks-near hazard'],
    ['my husband collapsed', 'person collapse'],
    ['someone collapsed, please help', 'person collapse'],
  ])('E1 with no rules: %j (%s)', (utterance) => {
    expect(classifyCallerSafety(utterance, {}).tier).toBe('E1');
  });

  it.each([
    'my sewer line collapsed and sewage is backing up',
    'the drain pipe collapsed',
    'the flames on my furnace are yellow',
  ])('trade homonym is NOT E1 (an E1 false positive hangs up on a customer): %j', (utterance) => {
    expect(classifyCallerSafety(utterance, {}).tier).not.toBe('E1');
  });
});

describe('classifyCallerSafety — upward-only bias (goal §3)', () => {
  it('a keyword-detected hazard is never downgraded below E2, even without engine tier context', () => {
    // "water everywhere" hits the detectEmergency backstop.
    const r = classifyCallerSafety('water everywhere in the kitchen', {}, rules);
    expect(['E1', 'E2']).toContain(r.tier);
    expect(r.tier).not.toBe('E3');
  });

  it('a benign false-positive with NO keyword backstop stays E3 (heat-pump defrost)', () => {
    // Engine false-positive guard fires only with winter context; no keyword
    // backstop hit -> routine. This is the one case a downgrade is allowed.
    const r = classifyCallerSafety(
      'steam coming off the outdoor unit',
      { season: 'winter', outdoorTempF: 30 },
      rules,
    );
    expect(r.tier).toBe('E3');
  });

  it('vulnerability amplifier keeps no-AC-in-heat at E2 (elderly)', () => {
    const r = classifyCallerSafety('no AC and it is brutal', {
      season: 'summer',
      outdoorTempF: 99,
      hasElderly: true,
    }, rules);
    expect(r.tier).toBe('E2');
  });
});
