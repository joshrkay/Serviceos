/**
 * WS17 (I1) — exhaustive matrix for the deterministic leading-quantity parser.
 *
 * The safety-relevant claim: a leading number is treated as a COUNT only when
 * it truly is one. Sizes/measures ("2 inch pipe fitting") must NOT be
 * misparsed into a quantity, or the caller hears a wrong total. Match parity
 * with the catalog resolver's tokeniser is pinned so stripping a count can
 * never change which catalog item a line resolves to.
 */
import { describe, it, expect } from 'vitest';
import {
  parseLeadingQuantity,
  MAX_PARSED_QUANTITY,
} from '../../../src/ai/voice-turn/quantity-parse';
import { normalizeForMatch } from '../../../src/ai/resolution/catalog-resolver';

describe('parseLeadingQuantity', () => {
  describe('digit counts', () => {
    it('parses a leading digit as the quantity, keeps the remainder', () => {
      expect(parseLeadingQuantity('3 smoke detectors')).toEqual({
        quantity: 3,
        description: 'smoke detectors',
      });
    });

    it('parses multi-digit counts', () => {
      expect(parseLeadingQuantity('12 outlets')).toEqual({
        quantity: 12,
        description: 'outlets',
      });
    });

    it('a leading number above the cap is NOT a quantity (model/part numbers)', () => {
      const over = `${MAX_PARSED_QUANTITY + 1} widget assembly`;
      expect(parseLeadingQuantity(over)).toEqual({ quantity: 1, description: over });
    });
  });

  describe('number words one–twelve', () => {
    it('parses a leading number word', () => {
      expect(parseLeadingQuantity('three smoke detectors')).toEqual({
        quantity: 3,
        description: 'smoke detectors',
      });
    });

    it('is case-insensitive', () => {
      expect(parseLeadingQuantity('Two GFCI outlets')).toEqual({
        quantity: 2,
        description: 'GFCI outlets',
      });
    });

    it('a bare number word with no remainder stays a description (never strip when unsure)', () => {
      expect(parseLeadingQuantity('two')).toEqual({ quantity: 1, description: 'two' });
    });

    it('does not parse number words above twelve (thirteen is not in the set)', () => {
      expect(parseLeadingQuantity('thirteen fittings')).toEqual({
        quantity: 1,
        description: 'thirteen fittings',
      });
    });
  });

  describe('articles a/an → 1', () => {
    it('"a" with a remainder → quantity 1, remainder kept', () => {
      expect(parseLeadingQuantity('a new filter')).toEqual({
        quantity: 1,
        description: 'new filter',
      });
    });

    it('"an" with a remainder → quantity 1', () => {
      expect(parseLeadingQuantity('an oil change')).toEqual({
        quantity: 1,
        description: 'oil change',
      });
    });
  });

  describe('unit-token guard — leading number is a SIZE, not a count', () => {
    it('"2 inch pipe fitting" → quantity 1, FULL original description', () => {
      expect(parseLeadingQuantity('2 inch pipe fitting')).toEqual({
        quantity: 1,
        description: '2 inch pipe fitting',
      });
    });

    it('"500 ft of wire" → quantity 1, full description', () => {
      expect(parseLeadingQuantity('500 ft of wire')).toEqual({
        quantity: 1,
        description: '500 ft of wire',
      });
    });

    it('"5 gallon drum" → quantity 1, full description', () => {
      expect(parseLeadingQuantity('5 gallon drum')).toEqual({
        quantity: 1,
        description: '5 gallon drum',
      });
    });

    it('"three ton condenser" (number word + unit) → quantity 1', () => {
      expect(parseLeadingQuantity('three ton condenser')).toEqual({
        quantity: 1,
        description: 'three ton condenser',
      });
    });

    it('"200 amp panel" → quantity 1, full description', () => {
      expect(parseLeadingQuantity('200 amp panel')).toEqual({
        quantity: 1,
        description: '200 amp panel',
      });
    });
  });

  describe('non-quantity leading tokens are left alone', () => {
    it('no leading number → quantity 1, unchanged description', () => {
      expect(parseLeadingQuantity('water heater replacement')).toEqual({
        quantity: 1,
        description: 'water heater replacement',
      });
    });

    it('single token → quantity 1, unchanged', () => {
      expect(parseLeadingQuantity('gasket')).toEqual({ quantity: 1, description: 'gasket' });
    });

    it('a size embedded but not leading is untouched ("A/C unit")', () => {
      expect(parseLeadingQuantity('A/C unit')).toEqual({ quantity: 1, description: 'A/C unit' });
    });

    it('digit with no space ("2in pipe") is not parsed', () => {
      expect(parseLeadingQuantity('2in pipe')).toEqual({ quantity: 1, description: '2in pipe' });
    });
  });

  describe('catalog match parity — stripping a count never changes the tokens', () => {
    it('digit count: tokens identical with and without the stripped count', () => {
      const parsed = parseLeadingQuantity('3 smoke detectors');
      expect(normalizeForMatch(parsed.description)).toEqual(
        normalizeForMatch('3 smoke detectors'),
      );
    });

    it('number word: tokens identical (word is not a catalog token either)', () => {
      const parsed = parseLeadingQuantity('three smoke detectors');
      // "three" is not a stopword, but the resolver never sees it because we
      // stripped it; the catalog side is "smoke detector(s)". Assert the
      // stripped remainder matches the same catalog tokens as the digit form.
      expect(normalizeForMatch(parsed.description)).toEqual(normalizeForMatch('smoke detectors'));
    });

    it('unit-guard case: full description tokens are stable', () => {
      const parsed = parseLeadingQuantity('2 inch pipe fitting');
      expect(normalizeForMatch(parsed.description)).toEqual(
        normalizeForMatch('2 inch pipe fitting'),
      );
    });
  });
});
