import { describe, it, expect } from 'vitest';
import {
  STATIC_ATOMS,
  PARAMETRIC_ATOM_PATTERNS,
  SENTINEL_ATOMS,
  tokenizeAtoms,
  isAtomValid,
  findUnknownAtoms,
  describeAtomGrammar,
} from '../../../src/ai/skills/condition-grammar';

describe('condition-grammar', () => {
  describe('tokenizeAtoms', () => {
    it('extracts a single atom', () => {
      expect(tokenizeAtoms('elderly')).toEqual(['elderly']);
    });

    it('strips operators and parens, lower-cases', () => {
      expect(
        tokenizeAtoms('Outdoor_Temp_Above_90F AND (Elderly OR Infant)'),
      ).toEqual(['outdoor_temp_above_90f', 'elderly', 'infant']);
    });

    it('handles whitespace-collapsed input', () => {
      expect(tokenizeAtoms('  elderly   OR   infant  ')).toEqual([
        'elderly',
        'infant',
      ]);
    });

    it('returns single token for "any" sentinel', () => {
      expect(tokenizeAtoms('any')).toEqual(['any']);
    });
  });

  describe('isAtomValid', () => {
    it('accepts every static atom', () => {
      for (const atom of STATIC_ATOMS) {
        expect(isAtomValid(atom)).toBe(true);
      }
    });

    it('accepts the "any" sentinel', () => {
      for (const atom of SENTINEL_ATOMS) {
        expect(isAtomValid(atom)).toBe(true);
      }
    });

    it('accepts every parametric pattern with a sample threshold', () => {
      // PARAMETRIC_ATOM_PATTERNS exposes the shape (e.g. outdoor_temp_below_<N>f)
      // — substitute a numeric threshold and confirm the regex matches.
      for (const { shape } of PARAMETRIC_ATOM_PATTERNS) {
        const concrete = shape.replace('<N>', '42');
        expect(isAtomValid(concrete)).toBe(true);
      }
    });

    it('rejects unknown static atom names', () => {
      expect(isAtomValid('elderly_present')).toBe(false);
      expect(isAtomValid('baby_in_home')).toBe(false);
      expect(isAtomValid('autumn')).toBe(false);
    });

    it('rejects malformed parametric atoms', () => {
      // Non-numeric threshold
      expect(isAtomValid('outdoor_temp_below_coldf')).toBe(false);
      // Missing 'f' suffix
      expect(isAtomValid('outdoor_temp_below_40')).toBe(false);
      // Different unit (celsius)
      expect(isAtomValid('outdoor_temp_below_4c')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isAtomValid('')).toBe(false);
    });
  });

  describe('findUnknownAtoms', () => {
    it('returns empty array when expression is fully valid', () => {
      expect(findUnknownAtoms('elderly OR infant')).toEqual([]);
      expect(
        findUnknownAtoms('outdoor_temp_above_90f AND (elderly OR infant)'),
      ).toEqual([]);
    });

    it('returns the unknown atoms only', () => {
      expect(findUnknownAtoms('elderly OR baby_in_home')).toEqual([
        'baby_in_home',
      ]);
    });

    it('returns ALL unknown atoms (not just the first)', () => {
      expect(
        findUnknownAtoms('elderly_present OR baby_in_home OR pet_in_home'),
      ).toEqual(['elderly_present', 'baby_in_home', 'pet_in_home']);
    });
  });

  describe('describeAtomGrammar', () => {
    it('mentions every static atom in the description', () => {
      const desc = describeAtomGrammar();
      for (const atom of STATIC_ATOMS) {
        expect(desc).toContain(atom);
      }
    });

    it('mentions every parametric pattern shape', () => {
      const desc = describeAtomGrammar();
      for (const { shape } of PARAMETRIC_ATOM_PATTERNS) {
        expect(desc).toContain(shape);
      }
    });

    it('mentions operators', () => {
      const desc = describeAtomGrammar();
      expect(desc).toMatch(/AND/);
      expect(desc).toMatch(/OR/);
    });
  });
});
