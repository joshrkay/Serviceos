/**
 * #1239 review — Spanish E1 monotonicity.
 *
 * Three review rounds in a row, a new suppressor (price, benign smoke, flame
 * colour, English-word count) downgraded a real emergency that main still
 * caught. Phrase tables pin what the author thought of; this corpus pins what
 * the life-safety reviewers probed with, measured against the tier origin/main
 * gave each phrase (recorded in the fixture, never regenerated on a branch).
 *
 * - A phrase that is E1 on main stays E1, unless it is listed in
 *   INTENDED_DOWNGRADES.
 * - A phrase that is E2 on main never drops to E3.
 * - Each INTENDED_DOWNGRADES entry records its fixture (main) tier AND its
 *   expected new tier, and both are asserted: a price question that falls to
 *   E3 instead of E2 fails. E3 is an allowed new tier only for the reviewed
 *   benign-smoke and figurative/non-person rows; price questions and the
 *   ambiguous object fall go to E2 (#1253 review).
 * Upgrades are allowed: ambiguity resolves upward (goal §3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCallerSafety } from '../../../../src/ai/agents/customer-calling/emergency-tier';

const FIXTURE = resolve(__dirname, 'fixtures/spanish-e1-monotonicity.tsv');

type Tier = 'E1' | 'E2' | 'E3';

/** Reviewed decisions only. `mainTier` is the fixture column; `expectedTier` is what the branch must give. */
const INTENDED_DOWNGRADES: ReadonlyMap<string, { mainTier: Tier; expectedTier: Tier; why: string }> = new Map([
  ['hay humo cuando prendo la calefacción por primera vez', { mainTier: 'E1', expectedTier: 'E3', why: 'first heat of the season burns off dust (#1239 review; English is E3)' }],
  ['hay humo de la carne asada en el patio', { mainTier: 'E1', expectedTier: 'E3', why: 'barbecue smoke outdoors (#1239 review)' }],
  ['¿cuánto sale el gas en Phoenix?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place (Josh, #1241)' }],
  ['¿a cómo sale el gas en esta zona?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place (Josh, #1241)' }],
  ['¿cuánto me sale el gas en la casa nueva?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place (Josh, #1241)' }],
  ['¿a cómo sale el gas por la tubería nueva?', { mainTier: 'E3', expectedTier: 'E2', why: 'price question naming a source (Josh, #1241)' }],
  ['¿cuánto sale el gas del calentador nuevo?', { mainTier: 'E3', expectedTier: 'E2', why: 'price question naming a source (Josh, #1241)' }],
  ['¿cuánto sale el gas del calentador?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source (Josh, #1241)' }],
  ['¿a cuánto sale el gas del tanque?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source (Josh, #1241)' }],
  ['¿cuánto sale el gas del tanque de 20 libras?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source (Josh, #1241)' }],
  ['¿a cómo sale el propano en su compañía?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a company (Josh, #1241)' }],
  ['¿cuánto sale el gas por aquí?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place (Josh, #1241)' }],
  ['mi hijo está herido de amor', { mainTier: 'E1', expectedTier: 'E3', why: 'figurative: heartbroken, not injured (#1245 round 2)' }],
  ['la película era sobre alguien inconsciente', { mainTier: 'E1', expectedTier: 'E3', why: 'fiction (#1245 round 2)' }],
  ['se desmayó la señal del wifi', { mainTier: 'E1', expectedTier: 'E3', why: 'a wifi signal dropping (#1245 round 2)' }],
  ['la cotización me dio convulsiones', { mainTier: 'E1', expectedTier: 'E3', why: 'a reaction to a quote (#1245 round 2)' }],
  ['el precio me dio un toque', { mainTier: 'E1', expectedTier: 'E3', why: 'a reaction to a price (#1245 round 2)' }],
  ['se cayó la tele y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'ambiguous object fall, no person named anywhere: human check (#1253 review)' }],
  // Same classes, found in the #1253 reviewer corpus (flagged on the PR for confirmation).
  ['a cómo sale el gas del tanque', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source, no "¿" (Josh, #1241)' }],
  ['se cayó la escalera y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'ambiguous object fall, no person named anywhere (#1253 review)' }],
  ['se cayó la escalera y no se puede levantar', { mainTier: 'E1', expectedTier: 'E2', why: 'ambiguous object fall, no person named anywhere (#1253 review)' }],
  ['se cayó el refrigerador y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'ambiguous object fall, no person named anywhere (#1253 review)' }],
  ['casi me infarto con la cotización', { mainTier: 'E1', expectedTier: 'E3', why: 'a reaction to a quote, the class of "la cotización me dio convulsiones" (#1245 round 2)' }],
  ['la luz se desmayó', { mainTier: 'E1', expectedTier: 'E3', why: 'a light going out, the class of "se desmayó la señal del wifi" (#1245 round 2)' }],
]);

const rows = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [mainTier, phrase] = line.split('\t') as [string, string];
    return { mainTier, phrase };
  });

describe('#1239 review — Spanish E1 monotonicity against origin/main', () => {
  it('the corpus is loaded and every row carries a main tier', () => {
    expect(rows.length).toBeGreaterThan(150);
    for (const { mainTier, phrase } of rows) {
      expect(['E1', 'E2', 'E3'], phrase).toContain(mainTier);
    }
  });

  it('every intended downgrade is in the corpus with its recorded main tier, and lands exactly on its expected tier', () => {
    for (const [phrase, { mainTier, expectedTier }] of INTENDED_DOWNGRADES) {
      expect(rows.find((r) => r.phrase === phrase)?.mainTier, `${phrase} (fixture main tier)`).toBe(mainTier);
      expect(classifyCallerSafety(phrase, {}).tier, `${phrase} (new tier)`).toBe(expectedTier);
    }
  });

  it('no phrase that is E1 on main loses E1, except the intended downgrades', () => {
    const lost = rows
      .filter(({ mainTier, phrase }) => mainTier === 'E1' && !INTENDED_DOWNGRADES.has(phrase))
      .map(({ phrase }) => ({ phrase, tier: classifyCallerSafety(phrase, {}).tier }))
      .filter(({ tier }) => tier !== 'E1');
    expect(lost).toEqual([]);
  });

  it('no phrase that is E2 on main drops to E3', () => {
    const dropped = rows
      .filter(({ mainTier }) => mainTier === 'E2')
      .map(({ phrase }) => ({ phrase, tier: classifyCallerSafety(phrase, {}).tier }))
      .filter(({ tier }) => tier === 'E3');
    expect(dropped).toEqual([]);
  });
});
