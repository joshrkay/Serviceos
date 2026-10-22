import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createLocation, updateLocation } from '../../src/locations/location';
import type { Customer } from '../../src/customers/customer';
import type { Geocoder } from '../../src/locations/geocoder';
import {
  listPendingLocations,
  runGeocodeSweep,
  writeGeocodeOutcome,
} from '../../src/workers/geocode-locations-sweep';
import { createLogger } from '../../src/logging/logger';

/**
 * Dispatch FR-2 phase 1 — pins the real columns of migration 327 and the
 * sweep's SQL (enumerator, guarded writes) against Postgres.
 */
describe('Postgres integration — service-location geocode sweep (migration 327)', () => {
  let pool: Pool;
  let customers: PgCustomerRepository;
  let locations: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };
  const logger = createLogger({ service: 'geocode-sweep-test', environment: 'test' });

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customers = new PgCustomerRepository(pool);
    locations = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function newLocation(street1: string, coords?: { latitude: number; longitude: number }) {
    const now = new Date();
    const customer: Customer = {
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      firstName: 'Geo',
      lastName: 'Code',
      displayName: 'Geo Code',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
    };
    const customerId = (await customers.create(customer)).id;
    return createLocation(
      { tenantId: tenant.tenantId, customerId, street1, city: 'Phoenix', state: 'AZ', postalCode: '85004', ...coords },
      locations,
    );
  }

  async function pendingFor(id: string) {
    return (await listPendingLocations(pool, 100_000)).find((p) => p.id === id);
  }

  it('a new address is pending and listed; one created with coordinates is ok and not listed', async () => {
    const pending = await newLocation('1 Pending St');
    const placed = await newLocation('2 Placed St', { latitude: 33.45, longitude: -112.07 });

    expect((await locations.findById(tenant.tenantId, pending.id))!.geocodeStatus).toBe('pending');
    expect((await locations.findById(tenant.tenantId, placed.id))!.geocodeStatus).toBe('ok');

    const listed = await pendingFor(pending.id);
    expect(listed).toMatchObject({
      tenantId: tenant.tenantId,
      attempts: 0,
      address: { street1: '1 Pending St', city: 'Phoenix', state: 'AZ', postalCode: '85004', country: 'US' },
    });
    expect(await pendingFor(placed.id)).toBeUndefined();
  });

  it('the sweep writes found coordinates and marks the row ok', async () => {
    const loc = await newLocation('3 Found Ave');
    const geocoder: Geocoder = {
      geocode: async (a) =>
        a.street1 === '3 Found Ave'
          ? { kind: 'found', coords: { latitude: 33.4484, longitude: -112.074 } }
          : { kind: 'not_found' },
    };
    const listPending = async () => (await listPendingLocations(pool, 100_000)).filter((p) => p.id === loc.id);
    const result = await runGeocodeSweep({
      listPending,
      writeOutcome: (l, o) => writeGeocodeOutcome(pool, l, o),
      geocoder,
      logger,
    });
    expect(result.found).toBe(1);

    const after = (await locations.findById(tenant.tenantId, loc.id))!;
    expect(after.geocodeStatus).toBe('ok');
    expect(after.latitude).toBeCloseTo(33.4484, 4);
    expect(after.longitude).toBeCloseTo(-112.074, 3);
    expect(after.geocodedAt).toBeInstanceOf(Date);
  });

  it('not_found marks failed; a retry only bumps attempts', async () => {
    const missing = await newLocation('4 Nowhere Ln');
    const flaky = await newLocation('5 Flaky Ct');

    expect(await writeGeocodeOutcome(pool, (await pendingFor(missing.id))!, { kind: 'not_found' })).toBe(true);
    expect(await writeGeocodeOutcome(pool, (await pendingFor(flaky.id))!, { kind: 'retry' })).toBe(true);

    const m = (await locations.findById(tenant.tenantId, missing.id))!;
    expect(m.geocodeStatus).toBe('failed');
    expect(m.latitude).toBeUndefined();
    const f = (await locations.findById(tenant.tenantId, flaky.id))!;
    expect(f.geocodeStatus).toBe('pending');
    expect(f.geocodeAttempts).toBe(1);
  });

  it('a write for an address edited mid-lookup misses, and the edit re-queues the row', async () => {
    const loc = await newLocation('6 Old Rd');
    const snapshot = (await pendingFor(loc.id))!;

    await updateLocation(tenant.tenantId, loc.id, { street1: '7 New Rd' }, locations);

    const written = await writeGeocodeOutcome(pool, snapshot, { kind: 'found', latitude: 1, longitude: 2 });
    expect(written).toBe(false);
    const after = (await locations.findById(tenant.tenantId, loc.id))!;
    expect(after.latitude).toBeUndefined();
    expect(after.geocodeStatus).toBe('pending');
    expect((await pendingFor(loc.id))!.address.street1).toBe('7 New Rd');
  });

  it('editing the address of a placed location clears its coordinates and re-queues it', async () => {
    const loc = await newLocation('8 Placed Way', { latitude: 33.5, longitude: -112.1 });
    await updateLocation(tenant.tenantId, loc.id, { postalCode: '85006' }, locations);
    const after = (await locations.findById(tenant.tenantId, loc.id))!;
    expect(after.latitude).toBeUndefined();
    expect(after.longitude).toBeUndefined();
    expect(after.geocodeStatus).toBe('pending');
  });
});
