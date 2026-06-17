import { describe, it, expect } from 'vitest';
import {
  resolveBillingLocation,
  getBillingLocation,
  createLocation,
  InMemoryLocationRepository,
  type ServiceLocation,
  type ServiceLocationAddressType,
} from '../../src/locations/location';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';

function loc(overrides: Partial<ServiceLocation> = {}): ServiceLocation {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT,
    customerId: CUSTOMER,
    street1: '1 Main St',
    city: 'Townsville',
    state: 'TX',
    postalCode: '75001',
    country: 'US',
    isPrimary: false,
    addressType: 'service' as ServiceLocationAddressType,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('billing address resolution (U3)', () => {
  it('prefers an explicit billing address over primary', () => {
    const billing = loc({ addressType: 'billing', street1: 'PO Box 9' });
    const primary = loc({ isPrimary: true, street1: '100 Job Site Rd' });
    const result = resolveBillingLocation([primary, billing]);
    expect(result?.id).toBe(billing.id);
  });

  it('prefers a both-typed address over primary when no pure billing exists', () => {
    const both = loc({ addressType: 'both' });
    const primary = loc({ isPrimary: true });
    expect(resolveBillingLocation([primary, both])?.id).toBe(both.id);
  });

  it('falls back to the primary service location when no billing/both', () => {
    const primary = loc({ isPrimary: true });
    const other = loc();
    expect(resolveBillingLocation([other, primary])?.id).toBe(primary.id);
  });

  it('falls back to the first active location when no primary', () => {
    const a = loc();
    const b = loc();
    expect(resolveBillingLocation([a, b])?.id).toBe(a.id);
  });

  it('ignores archived rows and returns null when none active', () => {
    const archivedBilling = loc({ addressType: 'billing', isArchived: true });
    expect(resolveBillingLocation([archivedBilling])).toBeNull();
  });

  it('getBillingLocation resolves via the repo, billing over primary', async () => {
    const repo = new InMemoryLocationRepository();
    // First created location auto-promotes to primary (service).
    await createLocation({ tenantId: TENANT, customerId: CUSTOMER, street1: '1 Job Rd', city: 'T', state: 'TX', postalCode: '75001' }, repo);
    const billing = await createLocation(
      { tenantId: TENANT, customerId: CUSTOMER, street1: 'PO Box 5', city: 'T', state: 'TX', postalCode: '75001', addressType: 'billing' },
      repo
    );

    const resolved = await getBillingLocation(TENANT, CUSTOMER, repo);
    expect(resolved?.id).toBe(billing.id);
    expect(resolved?.addressType).toBe('billing');
  });

  it('getBillingLocation falls back to primary when no billing address set', async () => {
    const repo = new InMemoryLocationRepository();
    const primary = await createLocation(
      { tenantId: TENANT, customerId: CUSTOMER, street1: '1 Job Rd', city: 'T', state: 'TX', postalCode: '75001' },
      repo
    );
    const resolved = await getBillingLocation(TENANT, CUSTOMER, repo);
    expect(resolved?.id).toBe(primary.id);
    expect(resolved?.isPrimary).toBe(true);
  });
});
