import { describe, it, expect } from 'vitest';
import { metroForAreaCode, metroForPhone, NPA_METROS } from '../../src/compliance/us-geography';

describe('metroForAreaCode', () => {
  it('places Cleveland area codes', () => {
    expect(metroForAreaCode('216')).toEqual({ kind: 'metro', metroCode: 'CLE', name: 'Cleveland' });
    expect(metroForAreaCode('440')).toEqual({ kind: 'metro', metroCode: 'CLE', name: 'Cleveland' });
  });
  it('places Phoenix and Houston', () => {
    expect(metroForAreaCode('480')).toMatchObject({ kind: 'metro', metroCode: 'PHX' });
    expect(metroForAreaCode('713')).toMatchObject({ kind: 'metro', metroCode: 'HOU' });
  });
  it('is unknown for a valid NANP code outside the table and for junk', () => {
    expect(metroForAreaCode('907')).toEqual({ kind: 'unknown' }); // Alaska, no metro row
    expect(metroForAreaCode('21')).toEqual({ kind: 'unknown' });
    expect(metroForAreaCode('abc')).toEqual({ kind: 'unknown' });
  });
  it('reports ambiguity when a code is listed under more than one metro', () => {
    const table = { ...NPA_METROS, XX1: { name: 'Alpha', areaCodes: ['999'] }, XX2: { name: 'Beta', areaCodes: ['999'] } };
    expect(metroForAreaCode('999', table)).toEqual({
      kind: 'ambiguous',
      metros: [
        { metroCode: 'XX1', name: 'Alpha' },
        { metroCode: 'XX2', name: 'Beta' },
      ],
    });
  });
  it('has no accidental ambiguity in the shipped table', () => {
    const seen = new Map<string, string>();
    for (const [code, m] of Object.entries(NPA_METROS)) {
      for (const npa of m.areaCodes) {
        expect(seen.has(npa), `${npa} listed under ${seen.get(npa)} and ${code}`).toBe(false);
        seen.set(npa, code);
      }
    }
  });
});

describe('metroForPhone', () => {
  it('reads the area code from E.164 and national formats', () => {
    expect(metroForPhone('+12165550142')).toMatchObject({ kind: 'metro', metroCode: 'CLE' });
    expect(metroForPhone('(216) 555-0142')).toMatchObject({ kind: 'metro', metroCode: 'CLE' });
    expect(metroForPhone('216-555-0142')).toMatchObject({ kind: 'metro', metroCode: 'CLE' });
  });
  it('is unknown for non-NANP numbers', () => {
    expect(metroForPhone('+447700900123')).toEqual({ kind: 'unknown' });
    expect(metroForPhone('')).toEqual({ kind: 'unknown' });
  });
});
