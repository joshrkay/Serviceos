import { describe, expect, it } from 'vitest';
import { parseDollarsToCents } from './money';

describe('parseDollarsToCents', () => {
  it('parses whole dollars to cents', () => {
    expect(parseDollarsToCents('1240')).toBe(124000);
    expect(parseDollarsToCents('0')).toBe(0);
  });

  it('parses two decimal places exactly (no float drift)', () => {
    expect(parseDollarsToCents('85.55')).toBe(8555);
    expect(parseDollarsToCents('1240.99')).toBe(124099);
    // The classic float trap: 85.55 * 100 === 8554.999999999999.
    expect(parseDollarsToCents('19.99')).toBe(1999);
  });

  it('pads a single decimal place to cents', () => {
    expect(parseDollarsToCents('12.5')).toBe(1250);
  });

  it('parses cents-only input with no leading whole dollars', () => {
    expect(parseDollarsToCents('.50')).toBe(50);
    expect(parseDollarsToCents('.5')).toBe(50);
    expect(parseDollarsToCents('$.99')).toBe(99);
  });

  it('rejects a bare decimal point with no digits', () => {
    expect(parseDollarsToCents('.')).toBeNull();
  });

  it('accepts a leading $ and thousands separators', () => {
    expect(parseDollarsToCents('$1,240.00')).toBe(124000);
    expect(parseDollarsToCents('$85.50')).toBe(8550);
  });

  it('rejects negatives, extra decimals, and non-numeric input', () => {
    expect(parseDollarsToCents('-5')).toBeNull();
    expect(parseDollarsToCents('1.234')).toBeNull();
    expect(parseDollarsToCents('abc')).toBeNull();
    expect(parseDollarsToCents('')).toBeNull();
    expect(parseDollarsToCents('   ')).toBeNull();
    expect(parseDollarsToCents('1.2.3')).toBeNull();
  });
});
