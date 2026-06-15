import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createLocation, getBillingLocation } from '../../src/locations/location';
import type { Customer } from '../../src/customers/customer';

function baseCustomer(tenantId: string, userId: string): Customer {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId,
    firstName: 'Pat',
    lastName: 'Property',
    displayName: 'Pat Property',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Postgres integration — service-location address_type (migration 188)', () => {
  let pool: Pool;
  let customers: PgCustomerRepository;
  let locations: PgLocationRepository;
  let tenant: { tenantId: string; userId: string };

  beforeAll(async () => {
    pool = await getSharedTestDb();
    customers = new PgCustomerRepository(pool);
    locations = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function newCustomer(): Promise<string> {
    return (await customers.create(baseCustomer(tenant.tenantId, tenant.userId))).id;
  }

  it('persists address_type and defaults existing-style rows to service', async () => {
    const customerId = await newCustomer();
    const created = await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '1 Job Rd', city: 'T', state: 'TX', postalCode: '75001' },
      locations
    );
    const found = await locations.findById(tenant.tenantId, created.id);
    expect(found!.addressType).toBe('service');
  });

  it('resolves the billing address over the primary service property', async () => {
    const customerId = await newCustomer();
    // Primary service property.
    await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '100 Job Site Rd', city: 'T', state: 'TX', postalCode: '75001' },
      locations
    );
    // Separate billing address.
    const billing = await createLocation(
      {
        tenantId: tenant.tenantId,
        customerId,
        street1: 'PO Box 42',
        city: 'T',
        state: 'TX',
        postalCode: '75001',
        addressType: 'billing',
      },
      locations
    );

    const resolved = await getBillingLocation(tenant.tenantId, customerId, locations);
    expect(resolved!.id).toBe(billing.id);
    expect(resolved!.addressType).toBe('billing');
  });

  it('falls back to the primary when the billing address is archived', async () => {
    const customerId = await newCustomer();
    const primary = await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '100 Job Site Rd', city: 'T', state: 'TX', postalCode: '75001' },
      locations
    );
    const billing = await createLocation(
      {
        tenantId: tenant.tenantId,
        customerId,
        street1: 'PO Box 42',
        city: 'T',
        state: 'TX',
        postalCode: '75001',
        addressType: 'billing',
      },
      locations
    );
    await locations.update(tenant.tenantId, billing.id, { isArchived: true, archivedAt: new Date() });

    const resolved = await getBillingLocation(tenant.tenantId, customerId, locations);
    expect(resolved!.id).toBe(primary.id);
  });

  it('can flip an existing service property to billing via update', async () => {
    const customerId = await newCustomer();
    const loc = await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '1 Main', city: 'T', state: 'TX', postalCode: '75001' },
      locations
    );
    const updated = await locations.update(tenant.tenantId, loc.id, { addressType: 'both' });
    expect(updated!.addressType).toBe('both');
    const resolved = await getBillingLocation(tenant.tenantId, customerId, locations);
    expect(resolved!.id).toBe(loc.id);
  });

  it('does not leak locations across tenants (RLS)', async () => {
    const customerId = await newCustomer();
    const created = await createLocation(
      { tenantId: tenant.tenantId, customerId, street1: '1 Main', city: 'T', state: 'TX', postalCode: '75001', addressType: 'billing' },
      locations
    );
    const other = await createTestTenant(pool);
    expect(await locations.findById(other.tenantId, created.id)).toBeNull();
  });
});
