import { describe, it, expect, vi } from 'vitest';
import { GoogleGeocoder, createGeocoder, formatAddressForGeocoding } from '../../src/locations/geocoder';

const ADDRESS = {
  street1: '100 N 1st St',
  street2: 'Suite 4',
  city: 'Phoenix',
  state: 'AZ',
  postalCode: '85004',
  country: 'US',
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('formatAddressForGeocoding', () => {
  it('joins street, city, state+zip and country, leaving the unit out', () => {
    expect(formatAddressForGeocoding(ADDRESS)).toBe('100 N 1st St, Phoenix, AZ 85004, US');
  });

  it('drops blank parts', () => {
    expect(formatAddressForGeocoding({ ...ADDRESS, city: '  ', postalCode: '' })).toBe('100 N 1st St, AZ, US');
  });
});

describe('GoogleGeocoder', () => {
  it('returns the first result as found', async () => {
    const fetchImpl = fakeFetch(200, {
      status: 'OK',
      results: [{ geometry: { location: { lat: 33.4484, lng: -112.074 } } }],
    });
    const g = new GoogleGeocoder({ apiKey: 'k', fetch: fetchImpl });
    await expect(g.geocode(ADDRESS)).resolves.toEqual({
      kind: 'found',
      coords: { latitude: 33.4484, longitude: -112.074 },
    });
    const url = new URL((fetchImpl as any).mock.calls[0][0]);
    expect(url.pathname).toBe('/maps/api/geocode/json');
    expect(url.searchParams.get('address')).toBe('100 N 1st St, Phoenix, AZ 85004, US');
    expect(url.searchParams.get('components')).toBe('country:US');
  });

  it('treats ZERO_RESULTS as not_found', async () => {
    const g = new GoogleGeocoder({ apiKey: 'k', fetch: fakeFetch(200, { status: 'ZERO_RESULTS', results: [] }) });
    await expect(g.geocode(ADDRESS)).resolves.toEqual({ kind: 'not_found' });
  });

  it.each([
    ['a quota error', 200, { status: 'OVER_QUERY_LIMIT' }],
    ['a refused key', 200, { status: 'REQUEST_DENIED' }],
    ['an HTTP error', 503, {}],
    ['an OK with no location', 200, { status: 'OK', results: [{}] }],
  ])('throws on %s so the sweep retries instead of failing the address', async (_label, status, body) => {
    const g = new GoogleGeocoder({ apiKey: 'k', fetch: fakeFetch(status, body) });
    await expect(g.geocode(ADDRESS)).rejects.toThrow();
  });

  it('never puts the API key in an error message', async () => {
    const g = new GoogleGeocoder({ apiKey: 'secret-key', fetch: fakeFetch(200, { status: 'REQUEST_DENIED' }) });
    await expect(g.geocode(ADDRESS)).rejects.toThrow(/^(?!.*secret-key)/);
  });
});

describe('createGeocoder', () => {
  it('is null without GOOGLE_MAPS_API_KEY and a Google geocoder with it', () => {
    expect(createGeocoder({})).toBeNull();
    expect(createGeocoder({ GOOGLE_MAPS_API_KEY: 'k' })).toBeInstanceOf(GoogleGeocoder);
  });
});
