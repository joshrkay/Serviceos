/**
 * PRIV-3 — the card-number scrubber runs on synchronous paths (every user
 * message the LLM gateway sends, the trace exporter, scrubPii, the
 * transcription worker's whole-call text), so its cost must stay linear in
 * the text and close to nothing on text that cannot hold a card.
 *
 * Measured against a baseline taken in the same test on the same input (a
 * linear pass that splits the text into words and lowercases each), so the
 * bound follows the machine: a quadratic step (200 KB of written phone
 * numbers took 1.3 s, of phone numbers as words 0.5 s, against a 4–5 ms
 * baseline) fails it by far, while a slow CI box does not. Best of three
 * runs each.
 */
import { describe, expect, it } from 'vitest';
import { redactCardNumbers } from '../../../src/ai/privacy/pan-redact';

function best(run: () => unknown): number {
  let fastest = Infinity;
  for (let k = 0; k < 3; k++) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

/** A linear pass over the same text: what tokenizing it costs at the least. */
function baseline(text: string): number {
  return best(() => text.split(/(\s+)/).map((word) => word.toLowerCase()));
}

const fill = (unit: string, bytes: number): string => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

describe('PRIV-3 — the card-number scrubber stays linear', () => {
  it.each([
    ['phone numbers, written', '602 555 0199, '],
    ['phone numbers, as words', 'six oh two five five five oh one nine nine, '],
    ['one unbroken run of digit words', 'one '],
    ['digits read in pairs', 'forty-one eleven, '],
    ['digit words and fillers', 'four one one one, uh, '],
  ])('200 KB of %s', (_name, unit) => {
    const text = fill(unit, 200_000);
    const allowed = 60 * baseline(text) + 150;
    expect(best(() => redactCardNumbers(text))).toBeLessThan(allowed);
  });

  // Cards found one after another in one run, or one after another each with
  // the card named next to it: work done once per card found must not walk
  // the whole run (every group's digits rebuilt per card: 100 KB of the first
  // took 0.06 s, 400 KB 3.1 s), nor every mention of the card in the text
  // (200 KB of the second 0.09 s, 1.6 MB 4.5 s). `times` the text may cost at
  // most 2.5 × `times` as much: linear work costs about `times`, quadratic its
  // square. Sized so the quadratic term dominates.
  it.each([
    ['cards read as words in one run', 'four one one one, one one one one, one one one one, one one one one, ', 100_000, 4],
    ['cards read in pairs, each named', 'card forty-one eleven, eleven eleven, eleven eleven, eleven eleven, ', 200_000, 8],
  ])('%s: more text costs proportionally more, never its square', (_name, unit, bytes, times) => {
    const small = fill(unit, bytes);
    const large = fill(unit, bytes * times);
    expect(redactCardNumbers(small)).toMatch(/^(?:card )?\[card number\]/);
    const smallMs = best(() => redactCardNumbers(small));
    const largeMs = best(() => redactCardNumbers(large));
    expect(largeMs).toBeLessThan(2.5 * times * smallMs + 20);
  });

  it('costs next to nothing on prose whose numbers cannot add up to a card', () => {
    const text = fill(
      'The customer called on 10/22 about the water heater installed in 2015; it was $250, and one of the techs said two hours. ',
      200_000,
    );
    // No tokenizing at all: a scan for digits and number words, comparable
    // to the baseline's one pass (tokenizing it all took about ten times it).
    expect(best(() => redactCardNumbers(text))).toBeLessThan(2 * baseline(text) + 5);
  });
});
