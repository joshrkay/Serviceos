import { describe, it, expect } from 'vitest';
import {
  parseDiscountAsk,
  resolveTargetFromParsedAsk,
} from '../../../src/conversations/negotiation/discount-ask-parser';

describe('parseDiscountAsk — percent off', () => {
  it.each([
    ['can you give me 10% off?', 1000],
    ['10 percent discount please', 1000],
    ['knock 25% off', 2500],
    ['2.5% off', 250],
    ['100% off lol', 10000],
  ])('%s → percent_off %d bps', (text, bps) => {
    expect(parseDiscountAsk(text)).toEqual({ kind: 'percent_off', bps });
  });

  it('rejects a nonsensical >100% as not-a-percent', () => {
    // 150% off is nonsense; with no $ amount it falls through to ambiguous.
    expect(parseDiscountAsk('150% off')).toEqual({ kind: 'ambiguous' });
  });
});

describe('parseDiscountAsk — amount off', () => {
  it.each([
    ['can you knock $50 off?', 5000],
    ['take $50 off the price', 5000],
    ['shave 50 bucks off', 5000],
    ['$50 discount would help', 5000],
    ['give me a discount of $49.99', 4999],
    ['$1,200 off a 20k job', 120000],
  ])('%s → amount_off %d cents', (text, cents) => {
    expect(parseDiscountAsk(text)).toEqual({ kind: 'amount_off', cents });
  });

  it('treats "10% off" as percent, never $10 off', () => {
    expect(parseDiscountAsk('10% off')).toEqual({ kind: 'percent_off', bps: 1000 });
  });
});

describe('parseDiscountAsk — target price', () => {
  it.each([
    ["I'll pay $180", 18000],
    ['do it for $180', 18000],
    ['make it $200', 20000],
    ['$200 not $250', 20000],
    ['$200 instead of $250', 20000],
    ['can you match their quote of $180?', 18000],
    ['give you $180 for it', 18000],
  ])('%s → target_price %d cents', (text, cents) => {
    expect(parseDiscountAsk(text)).toEqual({ kind: 'target_price', cents });
  });

  it('picks the lowest amount as the desired price', () => {
    expect(parseDiscountAsk('I was quoted $250 but will pay $200')).toEqual({
      kind: 'target_price',
      cents: 20000,
    });
  });
});

describe('parseDiscountAsk — ambiguous (conservative: never guess)', () => {
  it.each([
    'how much is it?',
    "what's your best price?",
    'can you do better?',
    'give me a discount',
    'cut me a deal',
    "that's too expensive",
    'the $250 is too much', // money present but no target/discount frame
    'lower the price', // no number
    'I have 2 dogs and a big yard', // bare number, not money
    'call me back at 5125550199', // phone digits, not money
    '', // empty
  ])('%s → ambiguous', (text) => {
    expect(parseDiscountAsk(text)).toEqual({ kind: 'ambiguous' });
  });
});

describe('resolveTargetFromParsedAsk — ground against the catalog list price', () => {
  const LIST = 25000;

  it('passes a target_price through verbatim', () => {
    expect(resolveTargetFromParsedAsk({ kind: 'target_price', cents: 18000 }, LIST)).toEqual({
      ambiguous: false,
      targetPriceCents: 18000,
    });
  });

  it('subtracts an amount_off from the list', () => {
    expect(resolveTargetFromParsedAsk({ kind: 'amount_off', cents: 5000 }, LIST)).toEqual({
      ambiguous: false,
      targetPriceCents: 20000,
    });
  });

  it('applies a percent_off via applyBps', () => {
    // 25000 - applyBps(25000, 1000) = 25000 - 2500 = 22500.
    expect(resolveTargetFromParsedAsk({ kind: 'percent_off', bps: 1000 }, LIST)).toEqual({
      ambiguous: false,
      targetPriceCents: 22500,
    });
  });

  it('floors an over-large amount_off at 0 (never negative)', () => {
    expect(resolveTargetFromParsedAsk({ kind: 'amount_off', cents: 30000 }, LIST)).toEqual({
      ambiguous: false,
      targetPriceCents: 0,
    });
  });

  it('passes ambiguous through to a CLARIFY target', () => {
    expect(resolveTargetFromParsedAsk({ kind: 'ambiguous' }, LIST)).toEqual({ ambiguous: true });
  });
});

describe('parse → resolve composes into an evaluator target', () => {
  it('"knock $50 off" on a $250 list → pay $200', () => {
    const parsed = parseDiscountAsk('can you knock $50 off?');
    expect(resolveTargetFromParsedAsk(parsed, 25000)).toEqual({
      ambiguous: false,
      targetPriceCents: 20000,
    });
  });

  it('"how much?" → ambiguous target regardless of list', () => {
    expect(resolveTargetFromParsedAsk(parseDiscountAsk('how much?'), 25000)).toEqual({
      ambiguous: true,
    });
  });
});
