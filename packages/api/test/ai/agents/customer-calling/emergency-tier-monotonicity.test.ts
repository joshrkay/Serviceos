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

/** Reviewed false positives only: main hangs up on these routine callers. */
const INTENDED_DOWNGRADES: ReadonlyMap<string, string> = new Map([
  ['hay humo cuando prendo la calefacción por primera vez', 'first heat of the season burns off dust (#1239 review; English is E3)'],
  ['hay humo de la carne asada en el patio', 'barbecue smoke outdoors (#1239 review)'],
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

  it('every intended downgrade is in the corpus and is E1 on main', () => {
    for (const phrase of INTENDED_DOWNGRADES.keys()) {
      expect(rows.find((r) => r.phrase === phrase)?.mainTier, phrase).toBe('E1');
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
