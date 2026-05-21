/**
 * P8-016 — thin weather-provider wrapper.
 *
 * Returns the max/min temperature (°F) observed for a locale over the last
 * 24h. The transport is INJECTED (`WeatherTransport`) so production wires a
 * real HTTP client and tests pass a deterministic stub — there is never a
 * real network call in unit tests.
 *
 * DEGRADE, NEVER BLOCK (hard rule): a provider 5xx / timeout / malformed
 * response must NOT throw out of `fetchRecentTemps`. It returns
 * `{ ok: false }`; the caller (weather detector / signal extractor) treats
 * that as "weather unavailable" and degrades to age + medical + property —
 * the call is never blocked on weather.
 */

export interface RecentTemps {
  /** Highest temperature (°F) in the trailing 24h window. */
  maxTempF: number;
  /** Lowest temperature (°F) in the trailing 24h window. */
  minTempF: number;
}

export type WeatherFetchResult =
  | { ok: true; temps: RecentTemps }
  | { ok: false; reason: string };

/**
 * The injected transport. Implementations call the real provider; tests pass
 * a stub. Implementations SHOULD resolve normally with the provider payload
 * and reject on transport errors (5xx, network) — the wrapper catches both.
 */
export type WeatherTransport = (input: {
  lat: number;
  lng: number;
}) => Promise<{ maxTempF: number; minTempF: number }>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export class WeatherClient {
  constructor(private readonly transport: WeatherTransport) {}

  /**
   * Fetch the trailing-24h temperature extremes for a locale. Never throws —
   * a failed/garbled fetch resolves to `{ ok: false }` so the caller can mark
   * the weather signal unavailable and continue.
   */
  async fetchRecentTemps(lat: number, lng: number): Promise<WeatherFetchResult> {
    try {
      const raw = await this.transport({ lat, lng });
      if (!raw || !isFiniteNumber(raw.maxTempF) || !isFiniteNumber(raw.minTempF)) {
        return { ok: false, reason: 'malformed weather provider response' };
      }
      return { ok: true, temps: { maxTempF: raw.maxTempF, minTempF: raw.minTempF } };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'weather provider error',
      };
    }
  }
}
