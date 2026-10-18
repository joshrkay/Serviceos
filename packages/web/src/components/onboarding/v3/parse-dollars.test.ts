import { describe, expect, it } from 'vitest';
import { parseDollarsToCents } from './parse-dollars';

describe('parseDollarsToCents', () => {
  it('reads whole dollars, with or without the dollar sign', () => {
    expect(parseDollarsToCents('$120')).toBe(12000);
    expect(parseDollarsToCents('120')).toBe(12000);
    expect(parseDollarsToCents('0')).toBe(0);
    expect(parseDollarsToCents('$0.00')).toBe(0);
  });

  it('reads one or two decimal places as cents', () => {
    expect(parseDollarsToCents('89.50')).toBe(8950);
    expect(parseDollarsToCents('89.5')).toBe(8950);
    expect(parseDollarsToCents('$89.05')).toBe(8905);
    expect(parseDollarsToCents('$0.07')).toBe(7);
  });

  it('never goes through a float (19.99 * 100 is 1998.9999999999998)', () => {
    expect(parseDollarsToCents('19.99')).toBe(1999);
    expect(parseDollarsToCents('1.15')).toBe(115);
    expect(parseDollarsToCents('4.35')).toBe(435);
    expect(Number.isInteger(parseDollarsToCents('$8,765,432.10'))).toBe(true);
  });

  it('allows thousands commas only where a thousands comma belongs', () => {
    expect(parseDollarsToCents('1,234')).toBe(123400);
    expect(parseDollarsToCents('$1,234.56')).toBe(123456);
    expect(parseDollarsToCents('1,234,567')).toBe(123456700);
    expect(parseDollarsToCents('1,2')).toBeNull();
    expect(parseDollarsToCents('12,34')).toBeNull();
    expect(parseDollarsToCents('1,2345')).toBeNull();
    expect(parseDollarsToCents(',100')).toBeNull();
    expect(parseDollarsToCents('1,234,')).toBeNull();
  });

  it('ignores spaces around the amount and after the dollar sign', () => {
    expect(parseDollarsToCents('  $120  ')).toBe(12000);
    expect(parseDollarsToCents('$ 120')).toBe(12000);
    expect(parseDollarsToCents(' 89.50 ')).toBe(8950);
    expect(parseDollarsToCents('1 200')).toBeNull();
    expect(parseDollarsToCents('12 0')).toBeNull();
  });

  it('rejects negatives in every spelling', () => {
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('$-5')).toBeNull();
    expect(parseDollarsToCents('-$5')).toBeNull();
    expect(parseDollarsToCents('(5)')).toBeNull();
    expect(parseDollarsToCents('-0')).toBeNull();
  });

  it('rejects more than two decimal places instead of rounding', () => {
    expect(parseDollarsToCents('89.999')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
    expect(parseDollarsToCents('0.001')).toBeNull();
  });

  it('rejects empty input, a bare sign or point, and half-typed amounts', () => {
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('   ')).toBeNull();
    expect(parseDollarsToCents('$')).toBeNull();
    expect(parseDollarsToCents('.')).toBeNull();
    expect(parseDollarsToCents('120.')).toBeNull();
    expect(parseDollarsToCents('.50')).toBeNull();
    expect(parseDollarsToCents('$.50')).toBeNull();
  });

  it('rejects anything that is not a dollar amount', () => {
    for (const text of ['abc', '12abc', '$$5', '5$', '1e3', '0x10', '1.2.3', '12/hr', 'free', '١٢٣']) {
      expect(parseDollarsToCents(text), text).toBeNull();
    }
  });

  it('keeps the result a safe integer: no more than seven digits of dollars', () => {
    expect(parseDollarsToCents('9999999')).toBe(999999900);
    expect(parseDollarsToCents('9,999,999.99')).toBe(999999999);
    expect(parseDollarsToCents('10000000')).toBeNull();
    expect(parseDollarsToCents('99999999999999999999')).toBeNull();
  });
});
