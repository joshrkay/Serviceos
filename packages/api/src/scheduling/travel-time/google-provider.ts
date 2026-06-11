import { LatLng, TravelTimeEstimate, TravelTimeProvider } from './provider';
import { HaversineFallbackProvider } from './haversine-fallback';

const DEFAULT_CACHE_TTL_SECONDS = Number(process.env.TRAVEL_TIME_CACHE_TTL_SECONDS ?? 300);
const DEFAULT_CACHE_MAX = Number(process.env.TRAVEL_TIME_CACHE_MAX_ENTRIES ?? 1000);
const DEPART_BUCKET_MINUTES = 15;

export interface GoogleProviderOptions {
  apiKey: string;
  fetch?: typeof fetch;
  fallback?: TravelTimeProvider;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  clock?: () => number;
  logger?: { warn: (msg: string) => void };
}

interface CacheEntry { value: TravelTimeEstimate; expiresAtMs: number; }

function round4(n: number): string { return n.toFixed(4); }

function bucketDepart(d: Date | undefined): string {
  if (!d) return 'none';
  const ms = d.getTime();
  const bucket = Math.floor(ms / (DEPART_BUCKET_MINUTES * 60_000));
  return String(bucket);
}

function cacheKey(o: LatLng, d: LatLng, depart: Date | undefined): string {
  return `${round4(o.latitude)},${round4(o.longitude)}->${round4(d.latitude)},${round4(d.longitude)}@${bucketDepart(depart)}`;
}

export class GoogleDistanceMatrixProvider implements TravelTimeProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: TravelTimeProvider;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly logger: { warn: (m: string) => void };
  private readonly cache = new Map<string, CacheEntry>(); // insertion-order = LRU eviction order

  constructor(opts: GoogleProviderOptions) {
    if (!opts.apiKey) throw new Error('GoogleDistanceMatrixProvider: apiKey required');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.fallback = opts.fallback ?? new HaversineFallbackProvider();
    this.ttlMs = (opts.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS) * 1000;
    this.maxEntries = opts.cacheMaxEntries ?? DEFAULT_CACHE_MAX;
    this.clock = opts.clock ?? (() => Date.now());
    this.logger = opts.logger ?? { warn: (m) => console.warn(m) };
  }

  async estimateDriveTime(origin: LatLng, destination: LatLng, departAt?: Date): Promise<TravelTimeEstimate> {
    const key = cacheKey(origin, destination, departAt);
    const now = this.clock();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs > now) {
      this.cache.delete(key);
      this.cache.set(key, hit); // refresh LRU position
      return hit.value;
    }
    try {
      const seconds = await this.callGoogle(origin, destination, departAt);
      const value: TravelTimeEstimate = { seconds, source: 'google', degraded: false };
      this.put(key, { value, expiresAtMs: now + this.ttlMs });
      return value;
    } catch (err) {
      this.logger.warn(`travel-time: google distance-matrix failed; falling back to haversine (host=maps.googleapis.com): ${(err as Error).message}`);
      const fb = await this.fallback.estimateDriveTime(origin, destination, departAt);
      return { ...fb, degraded: true };
    }
  }

  private async callGoogle(origin: LatLng, destination: LatLng, departAt?: Date): Promise<number> {
    const params = new URLSearchParams({
      origins: `${origin.latitude},${origin.longitude}`,
      destinations: `${destination.latitude},${destination.longitude}`,
      mode: 'driving',
      key: this.apiKey,
    });
    if (departAt) params.set('departure_time', String(Math.floor(departAt.getTime() / 1000)));
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const resp = await this.fetchImpl(url);
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const body = await resp.json() as {
      status: string;
      rows?: Array<{ elements?: Array<{ status: string; duration?: { value: number }; duration_in_traffic?: { value: number } }> }>;
    };
    if (body.status !== 'OK') throw new Error(`google status=${body.status}`);
    const el = body.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') throw new Error(`element status=${el?.status ?? 'missing'}`);
    const seconds = el.duration_in_traffic?.value ?? el.duration?.value;
    if (typeof seconds !== 'number') throw new Error('no duration in response');
    return seconds;
  }

  private put(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
