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
 *   INTENDED_DOWNGRADES with the reviewed reason.
 * - A phrase that is E2 on main never drops to E3.
 * Upgrades are allowed: ambiguity resolves upward (goal §3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCallerSafety } from '../../../../src/ai/agents/customer-calling/emergency-tier';

const FIXTURE = resolve(__dirname, 'fixtures/spanish-e1-monotonicity.tsv');

/** Reviewed decisions only: each row names why a main-E1 phrase may leave E1. */
const INTENDED_DOWNGRADES: ReadonlyMap<string, string> = new Map([
  ['hay humo cuando prendo la calefacción por primera vez', 'first heat of the season burns off dust (#1239 review; English is E3)'],
  ['hay humo de la carne asada en el patio', 'barbecue smoke outdoors (#1239 review)'],
  // Josh's decision (#1241): a gas price question with no leak or harm signal is E2 (human check).
  ['¿cuánto sale el gas en Phoenix?', 'price question naming a place → E2 (Josh, #1241)'],
  ['¿a cómo sale el gas en esta zona?', 'price question naming a place → E2 (Josh, #1241)'],
  ['¿cuánto me sale el gas en la casa nueva?', 'price question naming a place → E2 (Josh, #1241)'],
  ['¿a cómo sale el gas por la tubería nueva?', 'price question naming a source → E2 (Josh, #1241)'],
  ['¿cuánto sale el gas del calentador nuevo?', 'price question naming a source → E2 (Josh, #1241)'],
  ['¿cuánto sale el gas del calentador?', 'price question naming a source → E2 (Josh, #1241)'],
  ['¿a cuánto sale el gas del tanque?', 'price question naming a source → E2 (Josh, #1241)'],
  ['¿cuánto sale el gas del tanque de 20 libras?', 'price question naming a source → E2 (Josh, #1241)'],
  ['¿a cómo sale el propano en su compañía?', 'price question naming a company → E2 (Josh, #1241)'],
  ['¿cuánto sale el gas por aquí?', 'price question naming a place → E2 (Josh, #1241)'],
  // #1245 round 2, LOW over-triage: figurative or non-person readings with no person/harm signal → E3.
  ['mi hijo está herido de amor', 'heartbroken, not injured (#1245 round 2)'],
  ['la película era sobre alguien inconsciente', 'fiction (#1245 round 2)'],
  ['se desmayó la señal del wifi', 'a wifi signal dropping (#1245 round 2)'],
  ['la cotización me dio convulsiones', 'a reaction to a quote (#1245 round 2)'],
  ['el precio me dio un toque', 'a reaction to a price (#1245 round 2)'],
  // Same non-person-subject guard as above, found while adding the comma form of falls.
  ['se cayó la tele y no se puede mover', 'a TV fell and cannot be moved; no person or harm named (non-person subject, #1245 round 2 class)'],
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

  it('every intended downgrade is in the corpus and has actually left E1 (no stale entries)', () => {
    for (const phrase of INTENDED_DOWNGRADES.keys()) {
      expect(rows.some((r) => r.phrase === phrase), phrase).toBe(true);
      expect(classifyCallerSafety(phrase, {}).tier, phrase).not.toBe('E1');
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
