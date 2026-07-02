/**
 * U2 — deterministic milestone-sentence grammar.
 *
 * Table-driven: every accepted sentence must produce milestones that pass
 * validateMilestones (the parser re-checks internally; asserted again here so
 * the invariant is pinned from the outside too), and every rejected sentence
 * must return null — the task handler then flags `milestones` missing rather
 * than guessing a billing plan.
 */
import { describe, expect, it } from 'vitest';
import { parseMilestoneSentence } from '../../src/invoices/milestone-sentence-parser';
import { validateMilestones } from '../../src/invoices/invoice-schedule';

describe('parseMilestoneSentence — accepted shapes', () => {
  const cases: Array<{
    name: string;
    sentence: string;
    expected: Array<{ type: string; value?: number; trigger: string }>;
  }> = [
    {
      name: 'percent pair: deposit + completion (last percent → remainder)',
      sentence: 'Set up 50% deposit, 50% on completion for the Hendersons',
      expected: [
        { type: 'percent', value: 5000, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'percent + explicit rest wording',
      sentence: '30% up front and the rest on completion',
      expected: [
        { type: 'percent', value: 3000, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'three-way slash split (first on_accept, middle manual, last remainder)',
      sentence: 'Bill the Garcia install 30/30/40',
      expected: [
        { type: 'percent', value: 3000, trigger: 'on_accept' },
        { type: 'percent', value: 3000, trigger: 'manual' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'two-way slash split with split wording',
      sentence: '60/40 split',
      expected: [
        { type: 'percent', value: 6000, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'flat dollar deposit + remainder (integer cents, comma amount)',
      sentence: 'Take a $1,500 deposit up front on the Miller job, rest when we finish',
      expected: [
        { type: 'flat', value: 150000, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'flat dollars-and-cents deposit',
      sentence: '$250.50 deposit, balance on completion',
      expected: [
        { type: 'flat', value: 25050, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'word fraction: half up front',
      sentence: 'Half up front, the rest when the job is done',
      expected: [
        { type: 'percent', value: 5000, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
    {
      name: 'remainder trigger defaults to on_completion when unstated',
      sentence: '25% deposit and the balance later',
      expected: [
        { type: 'percent', value: 2500, trigger: 'on_accept' },
        { type: 'remainder', trigger: 'on_completion' },
      ],
    },
  ];

  it.each(cases)('$name', ({ sentence, expected }) => {
    const milestones = parseMilestoneSentence(sentence);
    expect(milestones).not.toBeNull();
    expect(validateMilestones(milestones!)).toEqual([]);
    expect(milestones!.map((m) => ({ type: m.type, trigger: m.trigger }))).toEqual(
      expected.map((e) => ({ type: e.type, trigger: e.trigger })),
    );
    for (let i = 0; i < expected.length; i++) {
      if (expected[i].value !== undefined) {
        expect(milestones![i].value).toBe(expected[i].value);
      }
      expect(milestones![i].label.length).toBeGreaterThan(0);
    }
  });
});

describe('parseMilestoneSentence — rejected shapes (→ null, handler marks missing)', () => {
  const rejected: Array<{ name: string; sentence: string }> = [
    { name: 'percents past 100%', sentence: '60% deposit, 70% on completion' },
    { name: 'slash split not summing to 100', sentence: '30/30/50 split' },
    { name: 'no remainder derivable: bare flat deposit', sentence: '$500 deposit up front' },
    { name: 'no remainder derivable: bare percent', sentence: '50% deposit' },
    {
      name: 'partial percents without a rest clause (sum < 100)',
      sentence: '30% deposit, 30% on completion',
    },
    { name: 'two remainder clauses', sentence: 'rest up front and the balance on completion' },
    { name: 'no billing tokens at all', sentence: 'for the Hendersons water heater job' },
    { name: 'empty', sentence: '   ' },
    {
      name: 'billing moment named but amount unparseable (never drop a spoken milestone)',
      sentence: 'a third to start, balance on completion',
    },
  ];

  it.each(rejected)('$name', ({ sentence }) => {
    expect(parseMilestoneSentence(sentence)).toBeNull();
  });
});
