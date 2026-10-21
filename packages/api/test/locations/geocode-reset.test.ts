import { describe, it, expect } from 'vitest';
import {
  InMemoryLocationRepository,
  createLocation,
  geocodeResetFor,
  updateLocation,
  type ServiceLocation,
  type UpdateLocationInput,
} from '../../src/locations/location';

const TENANT = '00000000-0000-0000-0000-000000000001';

function placed(): ServiceLocation {
  const now = new Date();
  return {
    id: 'loc-1',
    tenantId: TENANT,
    customerId: 'c-1',
    street1: '1 Main St',
    city: 'Phoenix',
    state: 'AZ',
    postalCode: '85004',
    country: 'US',
    latitude: 33.4,
    longitude: -112.0,
    isPrimary: true,
    addressType: 'service',
    geocodeStatus: 'ok',
    geocodeAttempts: 0,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('geocodeResetFor', () => {
  it('changes nothing when the address is untouched', () => {
    expect(geocodeResetFor(placed(), { label: 'Rental', accessNotes: 'gate 1234' })).toEqual({});
  });

  it('changes nothing when an address field is resent with the same value', () => {
    expect(geocodeResetFor(placed(), { street1: ' 1 Main St ', city: 'Phoenix' })).toEqual({});
  });

  it.each(['street1', 'street2', 'city', 'state', 'postalCode', 'country'] as const)(
    'clears coordinates and re-queues when %s changes',
    (field) => {
      const reset = geocodeResetFor(placed(), { [field]: 'changed' });
      expect(reset).toMatchObject({ geocodeStatus: 'pending', geocodeAttempts: 0 });
      expect('latitude' in reset && reset.latitude).toBeUndefined();
      expect('longitude' in reset).toBe(true);
    },
  );

  it('trusts coordinates the caller supplies, even with a new address', () => {
    const reset = geocodeResetFor(placed(), { street1: '9 Elm St', latitude: 1, longitude: 2 });
    expect(reset.geocodeStatus).toBe('ok');
    expect('latitude' in reset).toBe(false);
  });
});

describe('location writes carry geocode status', () => {
  it('createLocation is pending without coordinates and ok with them', async () => {
    const repo = new InMemoryLocationRepository();
    const base = { tenantId: TENANT, customerId: 'c-1', street1: '1 Main St', city: 'P', state: 'AZ', postalCode: '85004' };
    expect((await createLocation(base, repo)).geocodeStatus).toBe('pending');
    expect((await createLocation({ ...base, latitude: 1, longitude: 2 }, repo)).geocodeStatus).toBe('ok');
  });

  it('updateLocation ignores geocode state and ownership fields sent by a client', async () => {
    const repo = new InMemoryLocationRepository();
    await repo.create({ ...placed(), latitude: undefined, longitude: undefined, geocodeStatus: 'pending' });
    const body = {
      label: 'Rental',
      geocodeStatus: 'ok',
      geocodeAttempts: 99,
      customerId: 'someone-else',
      isArchived: true,
      isPrimary: false,
    } as unknown as UpdateLocationInput;
    const updated = await updateLocation(TENANT, 'loc-1', body, repo);
    expect(updated).toMatchObject({
      label: 'Rental',
      geocodeStatus: 'pending',
      geocodeAttempts: 0,
      customerId: 'c-1',
      isArchived: false,
      isPrimary: true,
    });
  });

  it('updateLocation with a new street drops the stale pin', async () => {
    const repo = new InMemoryLocationRepository();
    await repo.create(placed());
    const updated = await updateLocation(TENANT, 'loc-1', { street1: '2 Oak St' }, repo);
    expect(updated!.latitude).toBeUndefined();
    expect(updated!.geocodeStatus).toBe('pending');
  });
});
