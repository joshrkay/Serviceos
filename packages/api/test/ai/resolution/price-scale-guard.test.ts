/**
 * #909 (2026-08-31 live sweep, invoice INV-0022) — unit pins for the
 * price-scale guard. See src/ai/resolution/price-scale-guard.ts's own
 * doc comment for the full live shape and why the correction is
 * evidence-gated against the spoken utterance rather than a blind
 * "small price -> multiply" floor.
 */
import { describe, it, expect } from 'vitest';
import {
  correctDollarScaleIfSpoken,
  extractSpokenWholeDollarAmounts,
} from '../../../src/ai/resolution/price-scale-guard';

describe('extractSpokenWholeDollarAmounts', () => {
  it('extracts a "<N> dollars" mention', () => {
    expect(
      extractSpokenWholeDollarAmounts(
        'Draft an invoice for the Smiths for the AC job, 450 dollars for the AC repair',
      ),
    ).toEqual(new Set([450]));
  });

  it('extracts a "$N" mention', () => {
    expect(extractSpokenWholeDollarAmounts('Apply a $25 late fee')).toEqual(new Set([25]));
  });

  it('extracts multiple distinct whole-dollar mentions in one message', () => {
    expect(
      extractSpokenWholeDollarAmounts('$450 for the AC repair and 79 dollars for the diagnostic fee'),
    ).toEqual(new Set([450, 79]));
  });

  it('handles singular "dollar"', () => {
    expect(extractSpokenWholeDollarAmounts('1 dollar for the washer')).toEqual(new Set([1]));
  });

  it('is case-insensitive on "Dollars"', () => {
    expect(extractSpokenWholeDollarAmounts('450 Dollars for the repair')).toEqual(new Set([450]));
  });

  it('treats "$N.00" as the whole-dollar amount N', () => {
    expect(extractSpokenWholeDollarAmounts('$75.00 for the filter')).toEqual(new Set([75]));
  });

  it('does NOT extract a fractional dollar mention ("$12.50" is not evidence for 12 or 50)', () => {
    expect(extractSpokenWholeDollarAmounts('$12.50 for the part')).toEqual(new Set());
    expect(extractSpokenWholeDollarAmounts('12.50 dollars for the part')).toEqual(new Set());
  });

  it('returns an empty set for a message with no dollar-shaped mention', () => {
    expect(extractSpokenWholeDollarAmounts('Draft an invoice for the Smiths for the AC job')).toEqual(
      new Set(),
    );
  });

  it('returns an empty set for undefined/empty input', () => {
    expect(extractSpokenWholeDollarAmounts(undefined)).toEqual(new Set());
    expect(extractSpokenWholeDollarAmounts('')).toEqual(new Set());
  });

  it('ignores a zero or negative-looking mention (not a real dollar figure)', () => {
    expect(extractSpokenWholeDollarAmounts('0 dollars for the freebie')).toEqual(new Set());
  });
});

describe('correctDollarScaleIfSpoken', () => {
  it('the exact live shape: 450 (raw cents, meant $450) corrects to 45000 when "450 dollars" was spoken', () => {
    const spoken = extractSpokenWholeDollarAmounts('450 dollars for the AC repair');
    expect(correctDollarScaleIfSpoken(450, spoken)).toBe(45000);
  });

  it('the exact live shape: 79 (raw cents, meant $79) corrects to 7900 when "$79" was spoken', () => {
    const spoken = extractSpokenWholeDollarAmounts('$79 for the diagnostic fee');
    expect(correctDollarScaleIfSpoken(79, spoken)).toBe(7900);
  });

  it('the correct-scale case is left unchanged: 7500 (already $75.00) with "$75.00" spoken does not double-correct', () => {
    // 7500 does not itself equal any spoken WHOLE-dollar amount (75 is in
    // the set, not 7500), so no correction fires — this is the load-bearing
    // proof the guard does not touch an already-correct cents value.
    const spoken = extractSpokenWholeDollarAmounts('$75.00 for the filter');
    expect(correctDollarScaleIfSpoken(7500, spoken)).toBe(7500);
  });

  it('a negative value (a credit) is never touched, even if its magnitude matches a spoken figure', () => {
    const spoken = extractSpokenWholeDollarAmounts('50 dollars off for the repeat leak credit');
    expect(correctDollarScaleIfSpoken(-5000, spoken)).toBe(-5000);
  });

  it('a genuine sub-dollar price with NO matching spoken figure is left alone (the $0.79 part must stay possible)', () => {
    const spoken = extractSpokenWholeDollarAmounts('Draft an invoice for the Smiths for the AC job');
    expect(correctDollarScaleIfSpoken(79, spoken)).toBe(79);
  });

  it('zero is never corrected (a real comped/free line, and not a positive integer this guard considers)', () => {
    const spoken = extractSpokenWholeDollarAmounts('0 dollars for the freebie');
    expect(correctDollarScaleIfSpoken(0, spoken)).toBe(0);
  });

  it('a non-integer raw value is returned unchanged (not this guard\'s concern)', () => {
    const spoken = extractSpokenWholeDollarAmounts('450 dollars for the repair');
    expect(correctDollarScaleIfSpoken(450.5, spoken)).toBe(450.5);
  });

  it('an empty spoken-amounts set never corrects anything', () => {
    expect(correctDollarScaleIfSpoken(450, new Set())).toBe(450);
  });
});
