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
import {
  classifyCallerSafety,
  e1ScriptReadiness,
  E1_SCRIPT_REVIEW_REQUIRED,
  LIFE_SAFETY_E1_SCRIPT,
} from '../../../../src/ai/agents/customer-calling/emergency-tier';

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

// ─── FIX 10(iii) — embedded E2 table (sewage/AC phrases dead without it) ────

describe('runtime E2 vocabulary — embedded sewage/AC phrases (FIX 10iii)', () => {
  // Before the embedded table, classifyCallerSafety({}) had NO E2 signal for
  // any of these — the corpus TIER_2/TIER_3 additions were dead at runtime.
  it.each([
    'sewage backing up',
    'sewage is backing up',
    'sewage backing up into',
    'ac is out',
    'ac is completely out',
    'air conditioner is out',
    'no cooling',
  ])('classifies %j as E2 with NO rules loaded', (phrase) => {
    const r = classifyCallerSafety(phrase, {});
    expect(r.tier).toBe('E2');
    expect(r.requiresEvacuation).toBe(false);
  });

  it('classifies "sewage is backing up into the house" as E2 with no rules (was E3 before this fix)', () => {
    const r = classifyCallerSafety('sewage is backing up into the house', {});
    expect(r.tier).toBe('E2');
  });

  it.each([
    'I want to book my annual AC tune-up',
    'the AC is not as cold as it used to be',
    'can you send someone to clean out a slow drain',
  ])('routine utterances stay E3 with no rules: %j', (utterance) => {
    expect(classifyCallerSafety(utterance, {}).tier).toBe('E3');
  });

  it('an E1 hazard still wins over an embedded E2 phrase in the same utterance (upward-only bias)', () => {
    const r = classifyCallerSafety('I smell gas and the sewage is backing up too', {});
    expect(r.tier).toBe('E1');
  });
});

// ─── #1056 — Spanish life-safety hazards are E1, not the E2 backstop ────────

describe('#1056 — Spanish hazard reports classify E1 (runtime hot path, no rules)', () => {
  // One or more per English E1_HAZARD_PHRASES category. Unaccented variants
  // included because STT transcripts drop diacritics.
  it.each([
    // Gas leak / gas smell
    ['hay una fuga de gas en mi casa, huele muy fuerte', 'gas leak'],
    ['creo que hay un escape de gas en la cocina', 'gas leak'],
    ['huele a gas en todo el sótano', 'gas smell'],
    ['hay mucho olor a gas cerca del calentador', 'gas smell'],
    ['la cocina huele a huevo podrido', 'rotten eggs'],
    ['hay olor a azufre en el pasillo', 'sulfur smell'],
    // Carbon monoxide
    ['la alarma de monóxido de carbono está sonando', 'carbon monoxide'],
    ['la alarma de monoxido de carbono esta sonando', 'carbon monoxide, no accents'],
    ['el detector de monóxido no deja de pitar', 'CO detector'],
    // Fire / smoke
    ['hay un incendio en el garaje', 'fire'],
    ['la secadora está en llamas', 'on fire'],
    ['el calentador se prendió fuego', 'caught fire'],
    ['el calentador se prendio fuego', 'caught fire, no accents'],
    ['sale humo de las rejillas de la calefacción', 'smoke coming'],
    ['la casa está llena de humo', 'full of smoke'],
    ['huele a humo en el cuarto de los niños', 'smell smoke'],
    // Electrical burning / sparks
    ['el enchufe está echando chispas', 'sparking'],
    ['salen chispas del panel eléctrico', 'sparks from'],
    ['se están quemando los cables de la pared', 'wires burning'],
    ['huele a plástico quemado en el tablero', 'burning plastic'],
  ])('classifies %j as E1 (%s)', (utterance) => {
    const r = classifyCallerSafety(utterance, {});
    expect(r.tier).toBe('E1');
    expect(r.requiresEvacuation).toBe(true);
    expect(r.language).toBe('es');
    // No reviewed Spanish E1 script exists (O-2): the English evacuation
    // script, which leads with 911, is spoken.
    expect(r.responseScript).toBe(LIFE_SAFETY_E1_SCRIPT);
    expect(r.responseScript).toMatch(/911/);
  });

  it('the ticket utterance: "fuga de gas" is E1 with the Spanish keyword and language', () => {
    const r = classifyCallerSafety('hay una fuga de gas en mi casa, huele muy fuerte', {});
    expect(r).toMatchObject({
      tier: 'E1',
      keyword: 'fuga de gas',
      language: 'es',
      source: 'embedded',
      responseScript: LIFE_SAFETY_E1_SCRIPT,
    });
  });

  it('with the corpus rules loaded too, a Spanish gas leak is still E1 (upward-only)', () => {
    expect(classifyCallerSafety('hay una fuga de gas en mi casa', {}, rules).tier).toBe('E1');
  });

  it.each([
    ['no hay agua caliente', 'the ticket control: no hot water'],
    ['mi estufa de gas no prende', 'gas appliance, no hazard'],
    ['quiero una cotización para un calentador de gas', 'gas appliance quote'],
    ['necesito cambiar la batería del detector de humo', 'smoke detector battery'],
    ['quiero revisar la alarma de incendio de la oficina', 'fire alarm inspection'],
    ['las llamas del calentador están amarillas', 'flame-colour homonym (mirrors the English one)'],
    ['no hay fuego en el piloto del calentador', 'no-flame repair call (negation keeps "hay fuego" whole)'],
    ['no hay llamas en el quemador', 'no-flame repair call (negation keeps "hay llamas" whole)'],
    ['tengo una fuga de agua debajo del lavabo', 'water leak'],
    ['quiero agendar el mantenimiento anual del aire acondicionado', 'routine booking'],
  ])('a Spanish non-hazard call is NOT E1: %j (%s)', (utterance) => {
    const r = classifyCallerSafety(utterance, {});
    expect(r.tier).not.toBe('E1');
    expect(r.requiresEvacuation).toBe(false);
  });

  it('"olor a quemado" stays E2, mirroring English "burning smell" (E2 backstop, not E1)', () => {
    expect(classifyCallerSafety('burning smell in the hallway', {}).tier).toBe('E2');
    expect(classifyCallerSafety('hay olor a quemado en el pasillo', {}).tier).toBe('E2');
  });

  it('English E1 is unchanged: same tier, keyword, source and script', () => {
    expect(classifyCallerSafety('I smell gas in the basement', {})).toMatchObject({
      tier: 'E1',
      requiresEvacuation: true,
      keyword: 'smell gas',
      responseScript: LIFE_SAFETY_E1_SCRIPT,
      source: 'embedded',
    });
  });

  it('the matched phrase carries its language: en for an English hazard, es for the Spanish E2 backstop', () => {
    expect(classifyCallerSafety('I smell gas in the basement', {}).language).toBe('en');
    expect(classifyCallerSafety('hay olor a quemado en el pasillo', {}).language).toBe('es');
    expect(classifyCallerSafety('I want to book my annual tune-up', {}).language).toBeUndefined();
  });
});

// ─── #1220 review follow-up (#1056) — Spanish phrasing coverage ─────────────

describe('#1220 review — Spanish E1 phrasing, false positives and negation (one table)', () => {
  // Bucket E1: the caller reports a live hazard. Bucket not-E1: a routine
  // trade call or a denial of the hazard. An E1 false positive hangs up on the
  // customer; an E1 miss leaves a caller in a gas-filled house.
  const SPANISH_E1_TABLE: ReadonlyArray<[bucket: 'E1' | 'not-E1', utterance: string, why: string]> = [
    // Finding 3 — fire, smoke and electrical phrasings that returned no E1.
    ['E1', 'hay fuego en la cocina', 'fire'],
    ['E1', 'se está quemando la casa', 'house burning'],
    ['E1', 'hay humo saliendo del enchufe', 'smoke from an outlet'],
    ['E1', 'los cables se están quemando', 'wires burning'],
    ['E1', 'cortocircuito', 'short circuit'],
    ['E1', 'huele a quemado', 'burning smell (verb form)'],
    // Finding 3 — gas.
    ['E1', 'huele mucho a gas', 'strong gas smell'],
    ['E1', 'hay un olor fuerte a gas', 'strong gas smell'],
    ['E1', 'se huele gas', 'gas smell, impersonal'],
    ['E1', 'está saliendo gas de la estufa', 'gas escaping from the stove'],
    ['E1', 'huele a propano', 'propane smell'],
    // Finding 3 — carbon monoxide.
    ['E1', 'hay monóxido en la casa', 'CO present'],
    ['E1', 'el detector de CO está sonando', 'CO alarm sounding'],
    // English parity (question for Josh): English "rotten eggs" / "sulfur
    // smell" are E1 on main even when the water smells, so these stay E1.
    ['E1', 'el agua huele a huevo podrido', 'English parity: rotten eggs'],
    ['E1', 'el agua caliente huele a azufre', 'English parity: sulfur smell'],
    // Negation guard control: "bueno" ends in "no" but is not a negation.
    ['E1', 'bueno huele a gas en la cocina', '"bueno" is not "no"'],
    // Finding 4 — routine trade calls that must not hang up.
    ['not-E1', 'veo llamas amarillas en el calentador', 'flame colour diagnostic'],
    ['not-E1', 'el encendedor echa chispas pero no prende', 'igniter sparks, no ignition'],
    ['not-E1', 'chispas de la estufa al prender', 'stove igniter sparks'],
    ['not-E1', 'sale humo de la chimenea', 'chimney smoke is normal'],
    ['not-E1', 'necesito instalar un detector de monóxido', 'CO detector install'],
    // Finding 3 — negations of Spanish hazard phrases.
    ['not-E1', 'no huele a gas', 'negated gas smell'],
    ['not-E1', 'no hay fuga de gas', 'negated gas leak'],
    ['not-E1', 'no sale humo', 'negated smoke'],
    ['not-E1', 'no hay una fuga de gas', 'negated gas leak with article'],
    ['not-E1', 'no hay fuego en la cocina', 'negated fire'],
    ['not-E1', 'no huele a quemado', 'negated burning smell'],
    ['not-E1', 'no se huele gas', 'negated impersonal gas smell'],
    ['not-E1', 'no está saliendo gas de la estufa', 'negated gas escaping'],
    ['not-E1', 'no hay monóxido en la casa', 'negated CO'],
    ['not-E1', 'no hay humo en la casa', 'negated smoke in the house'],
    // Second review, finding 1 — "sale" is a price in Spanish and a sale in
    // English. Only a leak sense of "salir" counts.
    ['not-E1', 'do you have any on sale gas water heaters', 'English: "on sale"'],
    ['not-E1', 'any sale gas furnaces this month', 'English: "sale"'],
    ['not-E1', '¿cuánto me sale el gas?', 'price'],
    ['not-E1', '¿a cómo sale el propano?', 'price'],
    ['not-E1', 'el recibo me sale el gas muy caro', 'bill'],
    ['E1', 'está saliendo gas', 'gas escaping'],
    ['E1', 'sale gas de la estufa', 'gas escaping from the stove'],
    ['E1', 'sale gas de la tubería', 'gas escaping from the pipe'],
    ['E1', 'sale gas del calentador', 'gas escaping from the heater'],
    // Second review, finding 2 — real emergencies that were E3 (or E2).
    ['E1', 'huelo gas', 'I smell gas'],
    ['E1', 'huelo a gas', 'I smell gas'],
    ['E1', 'hay llamas en la cocina', 'flames in the kitchen'],
    ['E1', 'hay humo en la cocina', 'smoke in the kitchen'],
    ['E1', 'se está escapando el gas', 'gas escaping'],
    ['E1', 'se escapa el gas', 'gas escaping'],
    ['E1', 'no puedo apagar el fuego', 'cannot put the fire out (the phrase carries its own "no")'],
    ['E1', 'no me deja respirar el humo', 'smoke, cannot breathe (own "no")'],
    ['E1', 'no, no puedo apagar el fuego', 'a leading "no" does not negate it'],
    ['E1', 'no no puedo apagar el fuego', 'same, with the comma STT drops'],
    ['E1', 'huele a cable quemado', 'burning wire smell'],
    ['E1', 'no puedo respirar, hay humo', 'was E2 via the backstop'],
    ['not-E1', 'no huelo gas', 'negated: I do not smell gas'],
    ['not-E1', 'no hay llamas en la cocina', 'negated flames'],
    ['not-E1', 'no hay humo en la cocina', 'negated smoke'],
    ['not-E1', 'no huele a cable quemado', 'negated burning wire smell'],
    ['not-E1', 'hay humo saliendo de la chimenea', 'chimney smoke is normal'],
    // Second review, finding 3 — the flame-colour exception is only
    // "veo/hay llamas <colour> en/del <appliance>" with no other hazard word.
    ['E1', 'salen llamas amarillas y humo negro del calentador', 'flames coming out + smoke'],
    ['E1', 'veo llamas amarillas y humo en el calentador', 'colour plus another hazard word'],
    ['not-E1', 'hay llamas azules en la estufa', 'flame colour diagnostic'],
    // Second review, finding 4 — STT drops the accent and comma of "no sé,".
    ['E1', 'no se hay fuego', '"no sé, hay fuego"'],
    ['E1', 'no se sale humo del enchufe', '"no sé, sale humo del enchufe"'],
    ['not-E1', 'no se huele a gas', '"no se huele" is still a denial'],
    // Re-review, finding 1 — the leak sense of "salir"/"escapar" in every
    // word order, with an appliance as indirect object ("le sale gas").
    ['E1', 'se sale el gas', 'gas escaping'],
    ['E1', 'le sale gas a la estufa', 'the stove is leaking gas'],
    ['E1', 'a la estufa le sale gas', 'the stove is leaking gas'],
    ['E1', 'me sale gas de la estufa', 'gas coming out of my stove'],
    ['E1', 'sale gas por la hornilla', 'gas from the burner'],
    ['E1', 'sale gas de la cocina', 'gas from the kitchen'],
    ['E1', 'el gas se escapa', 'subject first'],
    ['E1', 'el gas se está saliendo', 'subject first'],
    ['E1', 'el gas está saliendo', 'subject first'],
    ['E1', 'está escapando gas', 'gas escaping'],
    ['E1', 'salió gas de la estufa', 'past tense'],
    ['E1', 'sale mucho gas de la estufa', 'a lot of gas'],
    ['E1', 'la estufa está botando gas', '"botar gas" = leaking gas'],
    ['not-E1', 'on sale gas water heaters', 'English: "on sale"'],
    ['not-E1', 'I bought a gas grill at a yard sale gas line needs hookup', 'English: "yard sale"'],
    ['not-E1', '¿sale gas en la factura?', 'bill'],
    ['not-E1', 'el gas sale muy caro', 'price, subject first'],
    ['not-E1', 'no le sale gas a la estufa', 'negated: the stove gets no gas'],
    // Re-review, finding 2 — smoke with an ordinary cause.
    ['not-E1', 'hay humo cuando prendo la calefacción por primera vez', 'first heat of the season'],
    ['not-E1', 'hay humo de la carne asada en el patio', 'barbecue'],
    // Re-review, finding 3 — flame colour plus CO symptoms, spread or a
    // dryer is not a colour diagnostic.
    ['E1', 'hay llamas amarillas en el calentador y me duele la cabeza', 'CO symptom'],
    ['E1', 'hay llamas amarillas en el calentador y estamos mareados', 'CO symptom'],
    ['E1', 'hay llamas amarillas en la estufa y se prendió la cortina', 'fire spread'],
    ['E1', 'hay llamas naranjas en el horno y en la pared', 'flames outside the appliance'],
    ['E1', 'veo llamas rojas en la secadora', 'a dryer has no visible flame'],
    // #1239 review — suppressors (price/bill/sale, benign smoke, flame colour,
    // English-word count) may apply only when nothing else in the utterance
    // signals a leak or danger.
    ['E1', 'sale gas del tanque, what do I do', 'English words + a gas source'],
    ['E1', 'sale gas de la estufa and it smells bad', 'English words + a gas source'],
    ['E1', 'ya pagué el recibo pero sale gas del medidor', 'bill word + a gas source'],
    ['E1', 'le sale gas al boiler, tengo la factura aquí', 'bill word + a gas source'],
    ['E1', 'prendí la calefacción por primera vez y hay humo en toda la casa', 'first heat + whole house'],
    ['E1', 'hay humo de la parrilla y los niños están tosiendo', 'barbecue + children coughing'],
    ['E1', 'hay humo del asador y se prendió la cerca', 'barbecue + fire spread'],
    ['E1', 'hay humo por primera vez y me arden los ojos', 'first heat + burning eyes'],
    ['E1', 'llamas amarillas y me siento mareado', 'flame colour + dizziness'],
    ['E1', 'flama amarilla en el calentador y me duele la cabeza', 'flame colour + headache'],
    ['E1', 'se siente el gas', 'gas smell, impersonal'],
    ['E1', '¿sale gas del calentador si lo instalan?', 'accepted: a gas source resolves upward'],
    ['E1', '¿no se puede apagar el fuego con agua?', 'accepted: may be a live fire'],
    ['E1', 'sale el gas', 'accepted: no price context'],
    ['not-E1', '¿qué tan caro me sale el gas?', 'price, "sale" not next to cuánto'],
    ['not-E1', '¿y cuánto es lo que me sale el gas al mes?', 'price'],
    ['not-E1', '¿con ustedes me sale el gas más barato?', 'price'],
    ['not-E1', 'el gas sale por cincuenta dólares al mes', 'price idiom "sale por <amount>"'],
    ['not-E1', 'el propano sale por tres dólares el galón', 'price idiom "sale por <amount>"'],
    ['not-E1', 'yard sale gas line', 'English: "yard sale"'],
    ['not-E1', 'sale gas prices', 'English: "sale gas prices"'],
    ['not-E1', 'hay llamas amarillas en el calentador, ¿está fuera de lo normal?', 'flame colour question; "fuera" is not spread'],
    ['not-E1', 'no me sale gas', 'denial: no gas supply'],
    ['not-E1', 'no nos sale gas de la estufa', 'denial: no gas supply'],
    // A suppressor's context must share the clause with the phrase it
    // suppresses; a quantity of gas is never a price.
    ['E1', 'sale gas, what do I do?', 'Spanish leak + separate English question'],
    ['E1', 'sale mucho gas, ¿cuánto cuesta la reparación?', 'leak + separate price question'],
    ['E1', 'hay humo por primera vez', '"por primera vez" alone is not a benign cause'],
    ['E1', 'hay humo, por primera vez pasa esto', 'benign cue in another clause'],
    // Third #1239 review, finding 1 — leak grammar "(sale|escapa…) (el) gas
    // (de|del|por|en|a) <source>" is never suppressed. STT drops the
    // punctuation, so a price word or an English question shares the clause.
    ['E1', 'sale gas del horno what do I do', 'leak grammar + English question'],
    ['E1', 'sale gas de la llave what do I do', 'leak grammar + English question'],
    ['E1', 'sale gas de la manguera what should I do', 'leak grammar + English question'],
    ['E1', 'sale gas de la válvula is that normal', 'leak grammar + English question'],
    ['E1', 'sale gas de la conexión what do I do', 'leak grammar + English question'],
    ['E1', 'sale gas por la llave de paso cuánto cuesta cambiarla', 'leak grammar + price question'],
    ['E1', 'sale gas por la línea cuánto cuesta', 'leak grammar + price question'],
    // Finding 2 — grill or incense smoke indoors is a CO risk.
    ['E1', 'hay humo del asador adentro de la casa', 'indoor grill smoke'],
    ['E1', 'hay humo del asador en el garaje', 'grill smoke in the garage'],
    ['E1', 'hay humo de la parrilla dentro de la casa', 'indoor grill smoke'],
    ['E1', 'hay humo del incienso en el cuarto', 'smoke in a room'],
    // Finding 3 — cuánto/cómo in front of leak grammar is not a price.
    ['E1', 'cómo me sale gas de la estufa, huele muy fuerte', '"cómo" + leak grammar'],
    ['E1', 'cómo sale gas del tanque', '"cómo" + leak grammar'],
    ['E1', 'cuánto sale gas del medidor', '"cuánto" + leak grammar'],
    ['E1', '¿cuánto tiempo sale gas antes de explotar?', 'explosion'],
    // Finding 4 — an appliance, a room or children alone are context, not danger.
    ['not-E1', 'el encendedor de la estufa echa chispas pero no prende', 'igniter sparks on a stove'],
    ['not-E1', 'quiero instalar un detector de monóxido en el cuarto de los niños', 'CO detector install'],
    ['E1', 'hay humo de la parrilla y los niños tosen', 'children + a harm verb'],
    // Finding 5 — the reviewer's keep-E1 rows.
    ['E1', 'cuánto cobran por revisar una fuga de gas', 'a leak named with a price question'],
    ['E1', 'ayer hubo una fuga de gas pero ya la arreglaron', 'past leak: resolves upward'],
  ];

  it.each(SPANISH_E1_TABLE)('%s: %j (%s)', (bucket, utterance) => {
    const r = classifyCallerSafety(utterance, {});
    if (bucket === 'E1') {
      expect(r.tier).toBe('E1');
      expect(r.requiresEvacuation).toBe(true);
      expect(r.language).toBe('es');
    } else {
      expect(r.tier).not.toBe('E1');
      expect(r.requiresEvacuation).toBe(false);
    }
  });

  // Third #1239 review, finding 5 — English "gas leak" stays E1 even in a quote
  // request (English table unchanged; kept upward on the reviewer's advice).
  it('"I need a quote for a gas leak detector" stays E1', () => {
    expect(classifyCallerSafety('I need a quote for a gas leak detector', {}).tier).toBe('E1');
  });

  // Re-review, finding 4 — deliberate tie-breaks. STT cannot tell "no se …"
  // from "no sé, …", so a leak verb after "no se" resolves upward (E1). Only
  // "no se huele" stays a denial; it still reaches E2 via the backstop.
  it.each([
    ['no se está saliendo el gas', 'E1'],
    ['no se escapa el gas', 'E1'],
    ['no se está escapando el gas', 'E1'],
    ['no se huele a gas', 'E2'],
  ] as const)('tie-break: %j is %s', (utterance, tier) => {
    expect(classifyCallerSafety(utterance, {}).tier).toBe(tier);
  });

  // Finding 5 — STT and copy-paste can deliver decomposed accents (NFD).
  it.each([
    'la alarma de monóxido está sonando',
    'el calentador se prendió fuego',
  ])('decomposed accents still classify E1: %j', (utterance) => {
    const decomposed = utterance.normalize('NFD');
    expect(decomposed).not.toBe(utterance);
    expect(classifyCallerSafety(decomposed, {}).tier).toBe('E1');
  });
});

// ─── #1221 — Spanish injury and medical emergencies are E1 ──────────────────

describe('#1221 — Spanish injury and medical emergencies (one table)', () => {
  const SPANISH_INJURY_TABLE: ReadonlyArray<[bucket: 'E1' | 'not-E1', utterance: string, why: string]> = [
    // Unconscious / unresponsive (English: unconscious, unresponsive, passed out, won't wake up)
    ['E1', 'mi papá está inconsciente', 'unconscious'],
    ['E1', 'mi esposa está desmayada', 'passed out'],
    ['E1', 'mi hijo se desmayó', 'passed out'],
    ['E1', 'mi abuela no responde', 'unresponsive, person subject'],
    // Not breathing (English: not breathing, stopped breathing)
    ['E1', 'mi bebé no respira', 'not breathing'],
    ['E1', 'mi mamá no puede respirar', 'cannot breathe'],
    ['E1', 'no puedo respirar', 'cannot breathe (was E2 via the backstop)'],
    ['E1', 'no no puede respirar', 'a leading "no" does not negate it'],
    ['E1', 'dejó de respirar', 'stopped breathing'],
    // Chest pain / heart attack
    ['E1', 'tiene dolor en el pecho', 'chest pain'],
    ['E1', 'me duele mucho el pecho', 'chest pain'],
    ['E1', 'creo que le está dando un infarto', 'heart attack'],
    ['E1', 'le dio un ataque al corazón', 'heart attack'],
    // Severe bleeding
    ['E1', 'sangra mucho de la cabeza', 'severe bleeding'],
    ['E1', 'hay mucha sangre', 'severe bleeding'],
    ['E1', 'está sangrando mucho', 'severe bleeding'],
    // Electrocution / shock (English: electrocuted, got shocked, electric shock)
    ['E1', 'el electricista se electrocutó', 'electrocuted'],
    ['E1', 'le dio la corriente', 'electric shock'],
    ['E1', 'me dio un toque el enchufe', 'got shocked'],
    // Seizure
    ['E1', 'le está dando una convulsión', 'seizure'],
    ['E1', 'está convulsionando', 'seizure'],
    // Choking
    ['E1', 'mi hijo se está ahogando', 'choking / drowning'],
    ['E1', 'la niña está atragantada', 'choking'],
    // Overdose, stroke
    ['E1', 'creo que es una sobredosis', 'overdose'],
    ['E1', 'le dio un derrame cerebral', 'stroke'],
    // Fell and cannot move
    ['E1', 'se cayó y no se puede mover', 'fell, cannot move'],
    ['E1', 'mi papá se cayó de la escalera y no se puede mover', 'fell from a ladder, cannot move'],
    ['E1', 'ayer se cayó y todavía no se puede mover', 'past fall, present urgency'],
    // Burned (injury sense; English: badly burned, severe burn)
    ['E1', 'se quemó la mano con aceite', 'burned hand'],
    ['E1', 'se me quemó el brazo con agua hirviendo', 'scalded arm'],
    ['E1', 'tiene quemaduras graves', 'severe burns'],
    // Someone hurt (English: someone is hurt / injured)
    ['E1', 'alguien está herido', 'someone is hurt'],
    // Negations
    ['not-E1', 'no está inconsciente', 'negated'],
    ['not-E1', 'ya respira bien', 'breathing again'],
    ['not-E1', 'no se desmayó', 'negated'],
    ['not-E1', 'no tiene dolor en el pecho', 'negated'],
    ['not-E1', 'no sangra mucho', 'negated'],
    ['not-E1', 'no está convulsionando', 'negated'],
    // Routine controls
    ['not-E1', 'el técnico se cayó de la lista', 'fell off the list'],
    ['not-E1', 'me duele el pecho de risa', 'laughing'],
    ['not-E1', 'necesito un electricista porque me dio un toque el enchufe ayer', 'past, resolved shock'],
    ['not-E1', 'el agua está hirviendo', 'boiling water'],
    ['not-E1', 'se me quemó la comida', 'burned food'],
    ['not-E1', 'el técnico no responde mis mensajes', 'an unresponsive technician'],
    ['not-E1', 'el pintor le dio un toque final a la pared', 'finishing touch'],
    ['not-E1', 'el drenaje no respira', 'plumbing vent'],
    ['not-E1', 'se ahoga el motor de la planta', 'engine flooding'],
    ['not-E1', 'se desmayó hace dos años', 'clearly past'],
    // #1245 review, finding 1 — a present symptom is never downgraded by a
    // past or hypothetical marker elsewhere; "desde ayer" is ongoing.
    ['E1', 'mi papá está inconsciente, ayer estaba bien', 'present state + past elsewhere'],
    ['E1', 'mi papá no responde desde ayer', '"desde ayer" is ongoing'],
    ['E1', 'tiene dolor en el pecho desde ayer', '"desde ayer" is ongoing'],
    ['E1', 'mi abuela se cayó anoche y no se puede levantar', 'past fall, present state'],
    ['E1', 'mi hijo no respira, no sé si alguien puede venir', '"si alguien" is not hypothetical here'],
    ['E1', 'mi hijo está convulsionando, de chico tenía epilepsia', 'present state + history'],
    ['E1', 'ayer se desmayo y otra vez no responde', 'no accent; present state'],
    // Finding 2 — the E2 fallback never wins over a present symptom.
    ['E1', 'se electrocutó ayer y está inconsciente', 'past shock, present unconsciousness'],
    // Finding 3 — missed phrasings.
    ['E1', 'tomó muchas pastillas', 'overdose'],
    ['E1', 'se le paralizó la cara', 'stroke sign'],
    ['E1', 'se cayó de la escalera y no se mueve', 'fell, not moving'],
    ['E1', 'se cayó de la escalera y no se levanta', 'fell, cannot get up'],
    ['E1', 'está desangrándose', 'enclitic'],
    ['E1', 'no sé qué le pasa, no responde', 'unresponsive, no named subject'],
    ['E1', 'se golpeó la cabeza y no responde', 'head injury, unresponsive'],
    ['E1', 'mi hijo está herido', 'hurt'],
    ['E1', 'no tiene pulso', 'no pulse'],
    ['E1', 'me electrocuté', 'first-person electrocution'],
    ['E1', 'le dio un derrame', 'stroke'],
    // Finding 4 — idioms with no person or symptom.
    ['not-E1', 'el precio es un infarto', 'price idiom'],
    ['not-E1', 'los precios están de infarto', 'price idiom'],
    ['not-E1', 'tengo convulsiones de risa', 'laughing'],
    ['not-E1', 'sobredosis de café', 'too much coffee'],
    ['not-E1', 'la bomba se ahogó', 'pump flooded'],
    ['not-E1', 'el calentador se ahoga', 'heater flooding'],
    ['E1', 'a mi papá le dio un infarto', 'the idiom word with a person'],
    ['not-E1', 'el control remoto no responde', 'a device, not a person'],
  ];

  it.each(SPANISH_INJURY_TABLE)('%s: %j (%s)', (bucket, utterance) => {
    const r = classifyCallerSafety(utterance, {});
    if (bucket === 'E1') {
      expect(r.tier).toBe('E1');
      expect(r.requiresEvacuation).toBe(true);
      expect(r.language).toBe('es');
    } else {
      expect(r.tier).not.toBe('E1');
    }
  });

  // A shock yesterday is not a life-safety call any more, but the outlet that
  // shocked the caller is still live: urgent same-day dispatch (E2), not a
  // routine booking.
  it('a past, resolved shock is E2: the caller is fine, the outlet is still a hazard', () => {
    expect(
      classifyCallerSafety('necesito un electricista porque me dio un toque el enchufe ayer', {}).tier,
    ).toBe('E2');
  });

  // #1245 review, finding 5 — the recent-shock E2 fallback is for ayer /
  // anteayer / anoche / hace N días (N ≤ 7) only.
  it('an old shock ("hace años le dio una descarga el panel") is routine E3, not E2', () => {
    expect(classifyCallerSafety('hace años le dio una descarga el panel', {}).tier).toBe('E3');
  });

  it('decomposed accents still classify E1: "se desmayó" in NFD', () => {
    expect(classifyCallerSafety('mi hijo se desmayó'.normalize('NFD'), {}).tier).toBe('E1');
  });
});

// ─── FIX 10(i) — E1_SCRIPT_REVIEW_REQUIRED boot-gate helper ─────────────────

describe('e1ScriptReadiness (boot gate)', () => {
  it('reports NOT ready while E1_SCRIPT_REVIEW_REQUIRED is true, with a prominent message', () => {
    const readiness = e1ScriptReadiness();
    expect(readiness.ready).toBe(E1_SCRIPT_REVIEW_REQUIRED ? false : true);
    expect(readiness.message.length).toBeGreaterThan(0);
    if (!readiness.ready) {
      expect(readiness.message).toMatch(/unreviewed|placeholder/i);
      expect(readiness.message).toMatch(/e1_reviewed_script/i);
    }
  });

  it('never throws (pure, boot-safe)', () => {
    expect(() => e1ScriptReadiness()).not.toThrow();
  });
});
