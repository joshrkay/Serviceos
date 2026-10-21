/**
 * Dispatch FR-2 phase 1 — the geocode sweep (P0-009 leader-gated sweep
 * pattern).
 *
 * Every tick it takes a bounded batch of `pending` service locations across
 * tenants, asks the geocoder for each address, and writes the outcome:
 *   found      → latitude/longitude, status `ok`
 *   not_found  → status `failed` (the provider looked; the address is not real)
 *   throw      → attempts + 1, row stays `pending`
 *
 * One mechanism covers create, edit, and backfill: new rows default to
 * `pending` (migration 327), an address edit resets to `pending`
 * (`geocodeResetFor` in locations/location.ts), and rows that predate 327 are
 * already `pending`.
 *
 * The provider call happens with no transaction open. The write is guarded on
 * the row still being `pending` with the SAME address the sweep geocoded, so
 * an owner who edits the address mid-lookup never gets the old house's pin.
 Only a definitive `not_found` makes a row `failed`. A throw is never
 * terminal: it usually means the provider is down, the quota is spent, or the
 * key has no Geocoding API enabled, and none of those says anything about the
 * address, so the row must still be retried once the provider recovers. A
 * throw also ends the batch after recording that row's attempt, so an outage
 * costs one provider call per tick. Rows are taken least-retried first, so a
 * row that keeps erroring sinks behind fresh ones instead of blocking them. A write that fails is logged and
 * counted; the batch goes on. A failing enumerator fails the pass, so the
 * leader tick records no heartbeat.
 */
import type { Pool } from 'pg';
import type { Logger } from '../logging/logger';
import { applyCrossTenantRole, clearTenantContext } from '../db/rls-runtime-role';
import { tenantQuery } from './tenant-query';
import type { GeocodableAddress, Geocoder, GeocodeResult } from '../locations/geocoder';

/** app.ts tick cadence. */
export const GEOCODE_SWEEP_TICK_MS = 5 * 60_000;

/** Locations per tick: 12/min sustained, well under the provider's rate limits. */
export const GEOCODE_SWEEP_BATCH_SIZE = 60;

export interface PendingLocation {
  id: string;
  tenantId: string;
  address: GeocodableAddress;
  attempts: number;
}

export type GeocodeOutcome =
  | { kind: 'found'; latitude: number; longitude: number }
  | { kind: 'not_found' }
  | { kind: 'retry' };

/** Pure: what to write for one lookup. `result` is null when the geocoder threw. */
export function decideGeocodeOutcome(result: GeocodeResult | null): GeocodeOutcome {
  if (result?.kind === 'found') {
    return { kind: 'found', latitude: result.coords.latitude, longitude: result.coords.longitude };
  }
  if (result?.kind === 'not_found') return { kind: 'not_found' };
  return { kind: 'retry' };
}

/**
 * Cross-tenant read of the oldest, least-retried pending rows. Runs under the
 * named `rls_cross_tenant` role. Archived rows and demo/platform tenants are
 * skipped (S6-1).
 */
const PENDING_LOCATIONS_SQL = `
  SELECT l.id, l.tenant_id, l.street1, l.street2, l.city, l.state,
         l.postal_code, l.country, l.geocode_attempts
    FROM service_locations l
    JOIN tenants t ON t.id = l.tenant_id
   WHERE l.geocode_status = 'pending'
     AND l.is_archived = false
     AND t.demo = false
     AND t.platform = false
   ORDER BY l.geocode_attempts, l.updated_at
   LIMIT $1
`;

export async function listPendingLocations(pool: Pool, limit: number): Promise<PendingLocation[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyCrossTenantRole(client, { transactional: true });
    const { rows } = await client.query(PENDING_LOCATIONS_SQL, [limit]);
    await client.query('COMMIT');
    return rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      address: {
        street1: r.street1,
        street2: r.street2,
        city: r.city,
        state: r.state,
        postalCode: r.postal_code,
        country: r.country,
      },
      attempts: Number(r.geocode_attempts),
    }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await clearTenantContext(client);
    client.release();
  }
}

/** Matches the row only while it is still pending at the address that was geocoded. */
const SAME_PENDING_ADDRESS = `
     WHERE tenant_id = $1 AND id = $2
       AND geocode_status = 'pending'
       AND street1 = $3 AND street2 IS NOT DISTINCT FROM $4
       AND city = $5 AND state = $6 AND postal_code = $7 AND country = $8`;

/** Writes one outcome under the row's tenant context. Returns false when the guard missed (address edited mid-lookup). */
export async function writeGeocodeOutcome(
  pool: Pool,
  loc: PendingLocation,
  outcome: GeocodeOutcome,
): Promise<boolean> {
  const a = loc.address;
  const guard = [loc.tenantId, loc.id, a.street1, a.street2 ?? null, a.city, a.state, a.postalCode, a.country];
  let sql: string;
  let extra: unknown[] = [];
  switch (outcome.kind) {
    case 'found':
      sql = `UPDATE service_locations
                SET latitude = $9, longitude = $10, geocode_status = 'ok', geocoded_at = NOW()
             ${SAME_PENDING_ADDRESS}`;
      extra = [outcome.latitude, outcome.longitude];
      break;
    case 'not_found':
      sql = `UPDATE service_locations
                SET geocode_status = 'failed', geocoded_at = NOW()
             ${SAME_PENDING_ADDRESS}`;
      break;
    case 'retry':
      sql = `UPDATE service_locations
                SET geocode_attempts = geocode_attempts + 1
             ${SAME_PENDING_ADDRESS}`;
      break;
  }
  const result = await tenantQuery(pool, loc.tenantId, sql, [...guard, ...extra]);
  return (result.rowCount ?? 0) > 0;
}

export interface GeocodeSweepDeps {
  listPending: (limit: number) => Promise<PendingLocation[]>;
  writeOutcome: (loc: PendingLocation, outcome: GeocodeOutcome) => Promise<boolean>;
  geocoder: Geocoder;
  logger: Logger;
  batchSize?: number;
}

export interface GeocodeSweepResult {
  candidates: number;
  found: number;
  notFound: number;
  retried: number;
  /** The address changed between the read and the write; the next tick picks the new one up. */
  superseded: number;
  failed: number;
}

export async function runGeocodeSweep(deps: GeocodeSweepDeps): Promise<GeocodeSweepResult> {
  const pending = await deps.listPending(deps.batchSize ?? GEOCODE_SWEEP_BATCH_SIZE);
  const result: GeocodeSweepResult = {
    candidates: pending.length,
    found: 0,
    notFound: 0,
    retried: 0,
    superseded: 0,
    failed: 0,
  };

  for (const loc of pending) {
    try {
      let lookup: GeocodeResult | null;
      try {
        lookup = await deps.geocoder.geocode(loc.address);
      } catch (err) {
        deps.logger.warn('Geocode sweep: lookup failed; will retry', {
          tenantId: loc.tenantId,
          locationId: loc.id,
          attempt: loc.attempts + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        lookup = null;
      }
      const outcome = decideGeocodeOutcome(lookup);
      const written = await deps.writeOutcome(loc, outcome);
      if (!written) {
        result.superseded++;
        if (lookup === null) break;
        continue;
      }
      if (outcome.kind === 'found') result.found++;
      else if (outcome.kind === 'not_found') result.notFound++;
      else result.retried++;
      if (lookup === null) break;
    } catch (err) {
      result.failed++;
      deps.logger.error('Geocode sweep: location failed; continuing', {
        tenantId: loc.tenantId,
        locationId: loc.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.candidates > 0) deps.logger.info('Geocode sweep complete', { ...result });
  return result;
}
