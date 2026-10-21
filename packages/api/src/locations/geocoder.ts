import type { LatLng } from '../scheduling/travel-time/provider';

/**
 * Dispatch FR-2 phase 1 — turns a service address into coordinates so the
 * travel-time feasibility check has something to measure.
 *
 * Two outcomes are answers: `found` and `not_found` (the provider looked and
 * the address does not exist). Anything else (timeout, quota, 5xx, a denied
 * key) THROWS, so the sweep counts it as a transient attempt and retries
 * instead of marking a real address as unplaceable.
 */
export type GeocodeResult = { kind: 'found'; coords: LatLng } | { kind: 'not_found' };

export interface GeocodableAddress {
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface Geocoder {
  geocode(address: GeocodableAddress): Promise<GeocodeResult>;
}

/** One-line address for the provider. street2 (unit/suite) is left out: it never moves the pin and often confuses matching. */
export function formatAddressForGeocoding(a: GeocodableAddress): string {
  return [a.street1, a.city, `${a.state} ${a.postalCode}`.trim(), a.country]
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(', ');
}

const GEOCODE_TIMEOUT_MS = 10_000;

export interface GoogleGeocoderOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

/** Google Geocoding API, on the same key the Distance Matrix provider already uses. */
export class GoogleGeocoder implements Geocoder {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleGeocoderOptions) {
    if (!opts.apiKey) throw new Error('GoogleGeocoder: apiKey required');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async geocode(address: GeocodableAddress): Promise<GeocodeResult> {
    const params = new URLSearchParams({
      address: formatAddressForGeocoding(address),
      components: `country:${address.country || 'US'}`,
      key: this.apiKey,
    });
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    const resp = await this.fetchImpl(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const body = (await resp.json()) as {
      status: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    if (body.status === 'ZERO_RESULTS') return { kind: 'not_found' };
    if (body.status !== 'OK') throw new Error(`google status=${body.status}`);
    const loc = body.results?.[0]?.geometry?.location;
    if (typeof loc?.lat !== 'number' || typeof loc.lng !== 'number') {
      throw new Error('no location in response');
    }
    return { kind: 'found', coords: { latitude: loc.lat, longitude: loc.lng } };
  }
}

/** Null when no key is configured: the sweep is then not scheduled at all, and rows stay `pending`. */
export function createGeocoder(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Geocoder | null {
  const key = env.GOOGLE_MAPS_API_KEY;
  return key ? new GoogleGeocoder({ apiKey: key }) : null;
}
