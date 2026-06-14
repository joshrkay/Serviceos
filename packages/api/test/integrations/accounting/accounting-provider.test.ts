import { describe, it, expect } from 'vitest';
import { createAccountingProvider } from '../../../src/integrations/accounting/accounting-provider';
import { XeroAccountingProviderStub } from '../../../src/integrations/accounting/xero-provider-stub';
import type { AccountingIntegration } from '../../../src/integrations/accounting/types';

const baseIntegration = (provider: AccountingIntegration['provider']): AccountingIntegration => ({
  id: 'int-1',
  tenantId: 'tenant-1',
  provider,
  accessTokenEncrypted: 'enc-a',
  refreshTokenEncrypted: 'enc-r',
  realmId: 'realm-1',
  connectedAt: new Date(),
  lastSyncedAt: null,
  status: 'active',
  errorMessage: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('accounting provider factory (P15-001 / T24-4)', () => {
  it('returns QuickBooks provider for quickbooks integrations', () => {
    const provider = createAccountingProvider(baseIntegration('quickbooks'), 'access-token');
    expect(provider).toBeDefined();
    expect(provider.createCustomer).toBeTypeOf('function');
    expect(provider.createSalesReceipt).toBeTypeOf('function');
  });

  it('returns Xero stub that rejects all operations', async () => {
    const provider = createAccountingProvider(baseIntegration('xero'), 'access-token');
    expect(provider).toBeInstanceOf(XeroAccountingProviderStub);
    await expect(provider.createCustomer({ displayName: 'Test Co' })).rejects.toThrow(
      /not yet available/,
    );
    await expect(
      provider.createSalesReceipt({
        customerRefId: 'c1',
        docNumber: 'INV-1',
        totalCents: 1000,
        lineDescriptions: ['Service'],
        txnDate: '2026-06-12',
      }),
    ).rejects.toThrow(/not yet available/);
  });
});
