import { describe, it, expect } from 'vitest';
import {
  formatStructuredAddress,
  parseCompleteSpokenAddress,
  parseSpokenAddressParts,
  readStructuredAddress,
  resolveSpokenAddress,
} from './spoken-address.js';

describe('parseSpokenAddressParts', () => {
  it('recovers everything from a fully-spoken address', () => {
    expect(parseSpokenAddressParts('412 Oak Street, Scottsdale, AZ 85254')).toEqual({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
  });

  it('handles the state and ZIP split across separate comma fields', () => {
    expect(parseSpokenAddressParts('412 Oak Street, Scottsdale, AZ, 85254')).toEqual({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
  });

  it('normalizes a spelled-out state name to its postal abbreviation', () => {
    expect(parseSpokenAddressParts('412 Oak Street, Scottsdale, Arizona 85254')).toMatchObject({
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
  });

  it('prefers the longest state-name match', () => {
    expect(parseSpokenAddressParts('9 Main Street, Elkins, West Virginia 26241')).toMatchObject({
      city: 'Elkins',
      state: 'WV',
    });
  });

  it('keeps a multi-word city intact', () => {
    expect(parseSpokenAddressParts('40 Elm Road, New York, NY 10001')).toMatchObject({
      city: 'New York',
      state: 'NY',
      postalCode: '10001',
    });
  });

  it('returns only what was actually said — the common job-site shape', () => {
    // 4 of the 5 real utterances captured in the field looked like this.
    expect(parseSpokenAddressParts('1207 Riverbell Drive')).toEqual({
      street1: '1207 Riverbell Drive',
    });
    expect(parseSpokenAddressParts('88 Sycamore Lane')).toEqual({ street1: '88 Sycamore Lane' });
  });

  it('recovers a ZIP even when the state was never spoken', () => {
    expect(parseSpokenAddressParts('412 Oak Street, Scottsdale, 85254')).toEqual({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      postalCode: '85254',
    });
  });

  it('handles ZIP+4', () => {
    expect(parseSpokenAddressParts('1 A Street, Boston, MA 02101-1234')).toMatchObject({
      postalCode: '02101-1234',
      state: 'MA',
    });
  });

  it('is empty for empty input', () => {
    expect(parseSpokenAddressParts('')).toEqual({});
    expect(parseSpokenAddressParts(undefined)).toEqual({});
  });
});

describe('parseCompleteSpokenAddress', () => {
  it('returns a value only when all four NOT NULL columns are recoverable', () => {
    expect(parseCompleteSpokenAddress('412 Oak Street, Scottsdale, AZ 85254')).toEqual({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
  });

  it('refuses to invent the missing parts', () => {
    expect(parseCompleteSpokenAddress('88 Sycamore Lane')).toBeUndefined();
    expect(parseCompleteSpokenAddress('1207 Riverbell Drive')).toBeUndefined();
    expect(parseCompleteSpokenAddress('34 Quarry Street')).toBeUndefined();
    expect(parseCompleteSpokenAddress('91 Fairway Avenue')).toBeUndefined();
    // No state — "412 Oak Street, Scottsdale, 85254" as actually spoken.
    expect(parseCompleteSpokenAddress('412 Oak Street, Scottsdale, 85254')).toBeUndefined();
  });
});

describe('readStructuredAddress', () => {
  it('reads exactly the service_locations free-text address columns', () => {
    expect(
      readStructuredAddress({
        name: 'ignored',
        address: 'ignored',
        street1: '412 Oak Street',
        street2: 'Unit 3',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
        country: 'US',
        latitude: 33.5,
      }),
    ).toEqual({
      street1: '412 Oak Street',
      street2: 'Unit 3',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'US',
    });
  });

  it('ignores blank and non-string values', () => {
    expect(readStructuredAddress({ city: '   ', state: 42, postalCode: null })).toEqual({});
    expect(readStructuredAddress(undefined)).toEqual({});
  });
});

describe('resolveSpokenAddress', () => {
  it("reports 'none' when the payload carries no address at all", () => {
    expect(resolveSpokenAddress({ name: 'Jane Smith' }).kind).toBe('none');
  });

  it("reports 'location' when the free text alone is complete", () => {
    const r = resolveSpokenAddress({ address: '412 Oak Street, Scottsdale, AZ 85254' });
    expect(r.kind).toBe('location');
    expect(r.location).toEqual({
      street1: '412 Oak Street',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
    expect(r.missing).toEqual([]);
  });

  it("reports 'note' with the verbatim words and what is still owed", () => {
    const r = resolveSpokenAddress({ address: '1207 Riverbell Drive' });
    expect(r.kind).toBe('note');
    expect(r.verbatim).toBe('1207 Riverbell Drive');
    expect(r.missing).toEqual(['city', 'state', 'postalCode']);
    // Prefill is what the review card puts in the boxes.
    expect(r.prefill.street1).toBe('1207 Riverbell Drive');
  });

  it('completes to a location once the approver supplies the gaps', () => {
    const r = resolveSpokenAddress({
      address: '1207 Riverbell Drive',
      street1: '1207 Riverbell Drive',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
    });
    expect(r.kind).toBe('location');
    expect(r.location).toMatchObject({ city: 'Scottsdale', postalCode: '85254' });
  });

  it("the approver's structured value WINS over the parser's guess", () => {
    // A regex must never overrule the human who corrected it.
    const r = resolveSpokenAddress({
      address: '412 Oak Street, Scottsdale, AZ 85254',
      city: 'Paradise Valley',
    });
    expect(r.location!.city).toBe('Paradise Valley');
  });

  it('parsed values only fill the gaps the approver left', () => {
    const r = resolveSpokenAddress({
      address: '412 Oak Street, Scottsdale, AZ 85254',
      postalCode: '85253',
    });
    expect(r.location).toMatchObject({ city: 'Scottsdale', postalCode: '85253' });
  });

  it('carries structured-only input (no spoken words) as a note when incomplete', () => {
    const r = resolveSpokenAddress({ street1: '1207 Riverbell Drive', city: 'Scottsdale' });
    expect(r.kind).toBe('note');
    expect(r.verbatim).toBe('1207 Riverbell Drive, Scottsdale');
    expect(r.missing).toEqual(['state', 'postalCode']);
  });

  it('carries street2 and country through to the location', () => {
    const r = resolveSpokenAddress({
      street1: '412 Oak Street',
      street2: 'Unit 3',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'CA',
    });
    expect(r.location).toEqual({
      street1: '412 Oak Street',
      street2: 'Unit 3',
      city: 'Scottsdale',
      state: 'AZ',
      postalCode: '85254',
      country: 'CA',
    });
  });
});

describe('formatStructuredAddress', () => {
  it('renders whatever pieces exist as one readable line', () => {
    expect(
      formatStructuredAddress({
        street1: '412 Oak Street',
        city: 'Scottsdale',
        state: 'AZ',
        postalCode: '85254',
      }),
    ).toBe('412 Oak Street, Scottsdale, AZ 85254');
    expect(formatStructuredAddress({ street1: '1207 Riverbell Drive' })).toBe(
      '1207 Riverbell Drive',
    );
    expect(formatStructuredAddress({})).toBe('');
  });
});
