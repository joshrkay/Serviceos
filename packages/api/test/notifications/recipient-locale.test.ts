/**
 * Recipient locale — where the quiet-hours window gets its timezone and
 * state from. Customers and service locations carry no zone, so the zone is
 * the tenant's; the states come from the customer's service locations and the
 * phone's area code. Anything unknown stays unknown (null zone / no state) so
 * the window applies its conservative fallback instead of a guess.
 */
import { describe, it, expect } from 'vitest';
import { createRecipientLocaleResolver } from '../../src/notifications/recipient-locale';
import { InMemorySettingsRepository, type TenantSettings } from '../../src/settings/settings';
import { InMemoryLocationRepository, type ServiceLocation } from '../../src/locations/location';

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-13T12:00:00Z');

function settings(over: Partial<TenantSettings> = {}): TenantSettings {
  return {
    id: 's-1',
    tenantId: TENANT,
    businessName: 'Acme',
    estimatePrefix: 'EST',
    invoicePrefix: 'INV',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 14,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function location(over: Partial<ServiceLocation>): ServiceLocation {
  return {
    id: over.id ?? 'loc-1',
    tenantId: TENANT,
    customerId: 'cust-1',
    street1: '1 Main St',
    city: 'Austin',
    state: 'TX',
    postalCode: '78701',
    country: 'US',
    isPrimary: true,
    addressType: 'service',
    isArchived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

async function build(opts: { settings?: TenantSettings; locations?: ServiceLocation[] }) {
  const settingsRepo = new InMemorySettingsRepository();
  if (opts.settings) await settingsRepo.create(opts.settings);
  const locationRepo = new InMemoryLocationRepository();
  for (const l of opts.locations ?? []) await locationRepo.create(l);
  return createRecipientLocaleResolver({ settingsRepo, locationRepo });
}

describe('createRecipientLocaleResolver', () => {
  it("uses the tenant's timezone and the customer's service-location states", async () => {
    const resolve = await build({
      settings: settings({ timezone: 'America/Chicago' }),
      locations: [location({ id: 'l1', state: 'TX' })],
    });

    const locale = await resolve({ tenantId: TENANT, customerId: 'cust-1', to: '+15125550100' });

    expect(locale).toEqual({ tenantTimezone: 'America/Chicago', serviceStates: ['TX'], areaCodeState: 'TX' });
  });

  it('reports an unknown zone as null when the tenant never chose one — never America/New_York', async () => {
    const resolve = await build({ settings: settings({ timezone: undefined }) });

    const locale = await resolve({ tenantId: TENANT, customerId: 'cust-1', to: '+15125550100' });

    expect(locale.tenantTimezone).toBeNull();
  });

  it('treats a stored zone the runtime cannot resolve as unknown', async () => {
    const resolve = await build({ settings: settings({ timezone: 'Foo/Bar' }) });

    const locale = await resolve({ tenantId: TENANT, customerId: 'cust-1', to: '+15125550100' });

    expect(locale.tenantTimezone).toBeNull();
  });

  it("reports the state a phone's area code belongs to (Florida 305)", async () => {
    const resolve = await build({
      settings: settings({ timezone: 'America/New_York' }),
      locations: [location({ id: 'l1', state: 'GA' })],
    });

    const locale = await resolve({ tenantId: TENANT, customerId: 'cust-1', to: '+13055550100' });

    expect(locale).toMatchObject({ serviceStates: ['GA'], areaCodeState: 'FL' });
  });
});
