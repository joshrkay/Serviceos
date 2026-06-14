/**
 * Unit tests for the deterministic target-price parser
 * (src/conversations/negotiation/target-price-parser.ts).
 *
 * Golden cases for every branch plus the conservative `ambiguous` default:
 * spoken word-numbers, no-number asks, conflicting numbers, and bare numbers
 * with no money cue must NEVER be guessed (precision over recall).
 */
import { describe, it, expect } from 'vitest';
import {
  parseDiscountTarget,
  type ParsedDiscountTarget,
} from '../../../src/conversations/negotiation/target-price-parser';

describe('parseDiscountTarget — target_price', () => {
  it('parses a $-prefixed integer dollar amount to cents', () => {
    expect(parseDiscountTarget('$200')).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 20000,
    });
  });

  it('parses thousands separators and cents ($1,250.50 → 125050)', () => {
    expect(parseDiscountTarget('$1,250.50')).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 125050,
    });
  });

  it('parses cents on a small amount ($200.50 → 20050)', () => {
    expect(parseDiscountTarget('$200.50')).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 20050,
    });
  });

  it('parses a spelled-out money suffix ("200 dollars" → 20000)', () => {
    expect(parseDiscountTarget('200 dollars')).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 20000,
    });
  });

  it('parses the "bucks" suffix ("200 bucks" → 20000)', () => {
    expect(parseDiscountTarget('200 bucks')).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 20000,
    });
  });

  it('parses a price embedded in a sentence ("I\'ll pay $200")', () => {
    expect(parseDiscountTarget("I'll pay $200")).toEqual<ParsedDiscountTarget>({
      kind: 'target_price',
      requestedTargetCents: 20000,
    });
  });
});

describe('parseDiscountTarget — discount_amount', () => {
  it('parses "knock $50 off" → 5000 cents', () => {
    expect(parseDiscountTarget('knock $50 off')).toEqual<ParsedDiscountTarget>({
      kind: 'discount_amount',
      requestedDiscountAmountCents: 5000,
    });
  });

  it('parses every reduction verb (take/shave/cut) with an amount and "off"', () => {
    for (const verb of ['take', 'shave', 'cut']) {
      expect(parseDiscountTarget(`${verb} $50 off`)).toEqual<ParsedDiscountTarget>({
        kind: 'discount_amount',
        requestedDiscountAmountCents: 5000,
      });
    }
  });

  it('allows words between the verb, amount, and "off"', () => {
    expect(parseDiscountTarget('can you knock $25 off the price')).toEqual<ParsedDiscountTarget>({
      kind: 'discount_amount',
      requestedDiscountAmountCents: 2500,
    });
  });
});

describe('parseDiscountTarget — discount_percent', () => {
  it('parses "10% off" → 1000 bps', () => {
    expect(parseDiscountTarget('10% off')).toEqual<ParsedDiscountTarget>({
      kind: 'discount_percent',
      requestedDiscountBps: 1000,
    });
  });

  it('parses "10 percent off" → 1000 bps', () => {
    expect(parseDiscountTarget('10 percent off')).toEqual<ParsedDiscountTarget>({
      kind: 'discount_percent',
      requestedDiscountBps: 1000,
    });
  });

  it('parses "10 percent" (no "off") → 1000 bps', () => {
    expect(parseDiscountTarget('10 percent')).toEqual<ParsedDiscountTarget>({
      kind: 'discount_percent',
      requestedDiscountBps: 1000,
    });
  });

  it('caps an over-100% ask as ambiguous', () => {
    expect(parseDiscountTarget('200% off')).toEqual<ParsedDiscountTarget>({ kind: 'ambiguous' });
  });

  it('does not read the bare number in "10% off" as a dollar target', () => {
    const result = parseDiscountTarget('10% off');
    expect(result.kind).toBe('discount_percent');
  });
});

describe('parseDiscountTarget — ambiguous (conservative default)', () => {
  const ambiguousCases = [
    'match my last quote',
    'can you do better on the price',
    "what's your best price",
    'how much is a water heater?',
    'two fifty', // spoken word-number — never interpreted
    '', // empty
    '   ', // whitespace only
    'give me a deal',
    'a couple hundred', // spoken word-number
  ];

  for (const text of ambiguousCases) {
    it(`is ambiguous for ${JSON.stringify(text)}`, () => {
      expect(parseDiscountTarget(text)).toEqual<ParsedDiscountTarget>({ kind: 'ambiguous' });
    });
  }

  it('is ambiguous for a bare number with no money cue', () => {
    expect(parseDiscountTarget('how about 200')).toEqual<ParsedDiscountTarget>({
      kind: 'ambiguous',
    });
  });

  it('is ambiguous when two competing money figures appear', () => {
    expect(
      parseDiscountTarget('I paid $300 last time, can you do $200 now'),
    ).toEqual<ParsedDiscountTarget>({ kind: 'ambiguous' });
  });

  it('is ambiguous when a dollar amount and a percent both appear', () => {
    expect(parseDiscountTarget('$200 or 10% off')).toEqual<ParsedDiscountTarget>({
      kind: 'ambiguous',
    });
  });

  it('rejects an absurd dollar value as ambiguous', () => {
    expect(parseDiscountTarget('$5,000,000')).toEqual<ParsedDiscountTarget>({ kind: 'ambiguous' });
  });

  it('rejects $0 as ambiguous (not a real target)', () => {
    expect(parseDiscountTarget('$0')).toEqual<ParsedDiscountTarget>({ kind: 'ambiguous' });
  });
});
