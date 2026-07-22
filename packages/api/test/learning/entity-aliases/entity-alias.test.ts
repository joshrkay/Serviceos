import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ENTITY_ALIAS_MAX_LENGTH,
  normalizeEntityAlias,
} from '../../../src/learning/entity-aliases/entity-alias';
import { ValidationError } from '../../../src/shared/errors';

const unicodeLength = (value: string): number => Array.from(value).length;
const containsControlOrFormatCharacter = (value: string): boolean =>
  /[\p{Cc}\p{Cf}]/u.test(value);

describe('normalizeEntityAlias', () => {
  it('normalizes Unicode compatibility forms, whitespace, and case', () => {
    expect(normalizeEntityAlias('  ＫＨＡＮ\u00a0 Family  ')).toBe('khan family');
  });

  it('rejects aliases whose Unicode normalization exceeds the database limit', () => {
    const expandsPastLimit = 'ﬃ'.repeat(41);

    expect(unicodeLength(expandsPastLimit)).toBeLessThan(ENTITY_ALIAS_MAX_LENGTH);
    expect(() => normalizeEntityAlias(expandsPastLimit)).toThrow(ValidationError);
  });

  it('rejects Unicode control characters plus zero-width and bidi format controls', () => {
    const controlCharacter = fc
      .oneof(fc.integer({ min: 0, max: 31 }), fc.integer({ min: 127, max: 159 }))
      .map((codePoint) => String.fromCodePoint(codePoint));
    const formatControl = fc.constantFrom(
      '\u200b',
      '\u200c',
      '\u200d',
      '\u2060',
      '\ufeff',
      '\u200e',
      '\u200f',
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u202e',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    );
    const disallowedCharacter = fc.oneof(controlCharacter, formatControl);

    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 20 }),
        disallowedCharacter,
        fc.string({ unit: 'binary', maxLength: 20 }),
        (prefix, disallowed, suffix) => {
          expect(() => normalizeEntityAlias(`${prefix}${disallowed}${suffix}`)).toThrow(
            ValidationError,
          );
        },
      ),
    );
  });

  it('matches the canonical transform and always returns a bounded value', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'binary', maxLength: ENTITY_ALIAS_MAX_LENGTH })
          .filter((value) => !containsControlOrFormatCharacter(value)),
        (value) => {
          const expected = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
          fc.pre(expected.length > 0);
          fc.pre(unicodeLength(value) <= ENTITY_ALIAS_MAX_LENGTH);
          fc.pre(unicodeLength(expected) <= ENTITY_ALIAS_MAX_LENGTH);

          const actual = normalizeEntityAlias(value);
          expect(actual).toBe(expected);
          expect(unicodeLength(actual)).toBeLessThanOrEqual(ENTITY_ALIAS_MAX_LENGTH);
          expect(containsControlOrFormatCharacter(actual)).toBe(false);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('rejects raw aliases longer than the database limit', () => {
    expect(() => normalizeEntityAlias('a'.repeat(ENTITY_ALIAS_MAX_LENGTH + 1))).toThrow(
      ValidationError,
    );
  });

  it('normalizes case and whitespace without changing the tenant-facing reference meaning', () => {
    expect(normalizeEntityAlias('  The   Khan  Account ')).toBe('the khan account');
  });

  it('rejects empty, zero-width, bidi, and control-character aliases', () => {
    expect(() => normalizeEntityAlias('   ')).toThrow(/alias/i);
    expect(() => normalizeEntityAlias('Khan\u0000')).toThrow(/alias/i);
    expect(() => normalizeEntityAlias('Kh\u200ban')).toThrow(/alias/i);
    expect(() => normalizeEntityAlias('Khan\u202e')).toThrow(/alias/i);
  });
});
