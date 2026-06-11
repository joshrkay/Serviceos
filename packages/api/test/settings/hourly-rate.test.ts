import { describe, it, expect } from 'vitest';
import { InMemorySettingsRepository, TenantSettings } from '../../src/settings/settings';

function makeSettings(tenantId: string): TenantSettings {
  const now = new Date();
  return {
    id: `settings-${tenantId}`,
    tenantId,
    businessName: 'Test Business',
    timezone: 'UTC',
    estimatePrefix: 'EST-',
    invoicePrefix: 'INV-',
    nextEstimateNumber: 1,
    nextInvoiceNumber: 1,
    defaultPaymentTermDays: 30,
    createdAt: now,
    updatedAt: now,
  };
}

describe('TenantSettings.hourlyRateCents', () => {
  it('round-trips through the in-memory repository update path', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings('t1'));

    const updated = await repo.update('t1', { hourlyRateCents: 15000 });
    expect(updated?.hourlyRateCents).toBe(15000);

    const fetched = await repo.findByTenant('t1');
    expect(fetched?.hourlyRateCents).toBe(15000);
  });

  it('defaults to undefined when never set', async () => {
    const repo = new InMemorySettingsRepository();
    await repo.create(makeSettings('t2'));
    const fetched = await repo.findByTenant('t2');
    expect(fetched?.hourlyRateCents).toBeUndefined();
  });
});
