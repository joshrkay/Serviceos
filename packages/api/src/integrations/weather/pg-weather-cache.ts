/**
 * P8-016 — Postgres-backed PUBLIC weather cache (migration 114).
 *
 * INTENTIONALLY TENANT-LESS. The cached datum is ambient temperature for a
 * rounded locale (~0.5°, roughly 30 mi); it is not tenant or customer PII, and
 * two tenants in the same locale share one row. Accordingly:
 *   - the `weather_cache` table has NO `tenant_id` column and NO RLS policy;
 *   - this repo uses `withClient()` (the cross-tenant escape hatch on
 *     PgBaseRepository), NOT `withTenant()`.
 *
 * Cache key = lat/lng rounded to 0.5°. `fetched_at` drives staleness: a row
 * older than `STALE_AFTER_MS` (1h) is treated as a miss so the caller refetches
 * from the provider.
 */
import { Pool } from 'pg';
import { PgBaseRepository } from '../../db/pg-base';
import type { RecentTemps } from './weather-client';

/** Cache entries older than this are stale → caller refetches. */
export const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

/** Round a coordinate to the nearest 0.5° (the cache key granularity). */
export function roundCoord(value: number): number {
  return Math.round(value * 2) / 2;
}

export interface WeatherCacheRow extends RecentTemps {
  latRounded: number;
  lngRounded: number;
  fetchedAt: Date;
}

export class PgWeatherCache extends PgBaseRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  /**
   * Return the cached temps for a locale, or null when there is no row OR the
   * row is stale (older than `STALE_AFTER_MS` relative to `now`). Public cache
   * → `withClient`, no tenant context.
   */
  async get(lat: number, lng: number, now: Date = new Date()): Promise<RecentTemps | null> {
    const latR = roundCoord(lat);
    const lngR = roundCoord(lng);
    return this.withClient(async (client) => {
      const result = await client.query(
        `SELECT max_temp_f, min_temp_f, fetched_at
           FROM weather_cache
          WHERE lat_rounded = $1 AND lng_rounded = $2`,
        [latR, lngR],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0] as Record<string, unknown>;
      const fetchedAt = new Date(row.fetched_at as string);
      if (now.getTime() - fetchedAt.getTime() > STALE_AFTER_MS) return null;
      return {
        maxTempF: Number(row.max_temp_f),
        minTempF: Number(row.min_temp_f),
      };
    });
  }

  /**
   * Upsert the cached temps for a locale, stamping `fetched_at = now()`.
   * Public cache → `withClient`, no tenant context.
   */
  async put(lat: number, lng: number, temps: RecentTemps): Promise<void> {
    const latR = roundCoord(lat);
    const lngR = roundCoord(lng);
    await this.withClient(async (client) => {
      await client.query(
        `INSERT INTO weather_cache (lat_rounded, lng_rounded, max_temp_f, min_temp_f, fetched_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (lat_rounded, lng_rounded)
         DO UPDATE SET max_temp_f = EXCLUDED.max_temp_f,
                       min_temp_f = EXCLUDED.min_temp_f,
                       fetched_at = now()`,
        [latR, lngR, temps.maxTempF, temps.minTempF],
      );
    });
  }
}
