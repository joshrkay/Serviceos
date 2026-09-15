/**
 * #1239 review — Spanish E1 monotonicity.
 *
 * Four review rounds in a row, a heuristic suppressor dropped a real emergency
 * that main still caught. Phrase tables pin what the author thought of; this
 * corpus pins what the life-safety reviewers probed with, measured against the
 * tier origin/main gives each phrase (the fixture column, regenerated with the
 * real classifier on origin/main, never on a branch).
 *
 * - No phrase may fall below its main tier (E1 -> E2/E3, E2 -> E3) unless it is
 *   listed in INTENDED_DOWNGRADES.
 * - Each listed entry records its main tier AND its expected new tier, and the
 *   test asserts both: a price question that falls to E3 instead of E2 fails.
 * - #1253 round 2, rule 1: a heuristic suppressor lowers E1 to E2 at most. The
 *   only rows allowed at E3 are the two benign-smoke rows approved in #1239.
 * Upgrades are allowed: ambiguity resolves upward (goal §3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCallerSafety } from '../../../../src/ai/agents/customer-calling/emergency-tier';

const FIXTURE = resolve(__dirname, 'fixtures/spanish-e1-monotonicity.tsv');

type Tier = 'E1' | 'E2' | 'E3';
const RANK: Record<Tier, number> = { E1: 3, E2: 2, E3: 1 };

/** Reviewed decisions only. `mainTier` is the fixture column; `expectedTier` is what the branch must give. */
const INTENDED_DOWNGRADES: ReadonlyMap<string, { mainTier: Tier; expectedTier: Tier; why: string }> = new Map([
  // Approved in #1239: the only rows a heuristic suppressor may take to E3.
  ['hay humo cuando prendo la calefacción por primera vez', { mainTier: 'E3', expectedTier: 'E3', why: 'first heat of the season burns off dust (#1239 review; English is E3)' }],
  ['hay humo de la carne asada en el patio', { mainTier: 'E3', expectedTier: 'E3', why: 'barbecue smoke outdoors (#1239 review)' }],
  // Josh's decision (#1241): a gas price question with no leak or harm signal is E2 (human check).
  ['¿cuánto sale el gas en Phoenix?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place' }],
  ['¿a cómo sale el gas en esta zona?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place' }],
  ['¿cuánto me sale el gas en la casa nueva?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place' }],
  ['¿a cómo sale el gas por la tubería nueva?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source' }],
  ['¿cuánto sale el gas del calentador nuevo?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source' }],
  ['¿cuánto sale el gas del calentador?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source' }],
  ['¿a cuánto sale el gas del tanque?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source' }],
  ['¿cuánto sale el gas del tanque de 20 libras?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source' }],
  ['¿a cómo sale el propano en su compañía?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a company' }],
  ['¿cuánto sale el gas por aquí?', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a place' }],
  ['a cómo sale el gas del tanque', { mainTier: 'E1', expectedTier: 'E2', why: 'price question naming a source, no "¿" (confirmed in the #1253 round-2 review)' }],
  // #1253 round 2, rule 1: figurative / fiction / device / price readings are capped at E2, never E3.
  ['mi hijo está herido de amor', { mainTier: 'E1', expectedTier: 'E2', why: 'figurative: heartbroken' }],
  ['la película era sobre alguien inconsciente', { mainTier: 'E1', expectedTier: 'E2', why: 'fiction' }],
  ['se desmayó la señal del wifi', { mainTier: 'E1', expectedTier: 'E2', why: 'a device subject right after the verb (rule 3)' }],
  ['la cotización me dio convulsiones', { mainTier: 'E1', expectedTier: 'E2', why: 'a reaction to a quote' }],
  ['el precio me dio un toque', { mainTier: 'E1', expectedTier: 'E2', why: 'a reaction to a price' }],
  ['casi me infarto con la cotización', { mainTier: 'E1', expectedTier: 'E2', why: 'a reaction to a quote' }],
  // #1253 round 2, rule 2: the exact shape "se cayó <article> <household object> (y|,) <cannot-move>" is E2.
  ['se cayó la tele y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'exact object-fall shape' }],
  ['se cayó la escalera y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'exact object-fall shape' }],
  ['se cayó el refrigerador y no se puede mover', { mainTier: 'E1', expectedTier: 'E2', why: 'exact object-fall shape' }],
]);

/** The two approved benign-smoke rows: the only phrases allowed to land on E3 from a higher main tier. */
const E3_ALLOWED = new Set([
  'hay humo cuando prendo la calefacción por primera vez',
  'hay humo de la carne asada en el patio',
]);

const rows = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => {
    const [mainTier, phrase] = line.split('\t') as [Tier, string];
    return { mainTier, phrase };
  });

describe('#1239 review — Spanish E1 monotonicity against origin/main', () => {
  it('the corpus is loaded and every row carries a main tier', () => {
    expect(rows.length).toBeGreaterThan(600);
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

  it('only the two approved smoke rows may be an intended move to E3 (rule 1: E2 floor)', () => {
    for (const [phrase, { mainTier, expectedTier }] of INTENDED_DOWNGRADES) {
      if (expectedTier === 'E3' && RANK[mainTier] > RANK.E3) expect(E3_ALLOWED.has(phrase), phrase).toBe(true);
    }
  });

  it('no fixture row falls below its main tier, except the intended downgrades', () => {
    const dropped = rows
      .map(({ mainTier, phrase }) => ({ phrase, mainTier, tier: classifyCallerSafety(phrase, {}).tier as Tier }))
      .filter(({ phrase, mainTier, tier }) => RANK[tier] < RANK[mainTier] && !INTENDED_DOWNGRADES.has(phrase));
    expect(dropped).toEqual([]);
  });
});
