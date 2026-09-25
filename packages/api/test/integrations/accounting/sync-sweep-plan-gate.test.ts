import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  AccountingSyncService,
  runAccountingSyncSweep,
} from '../../../src/integrations/accounting/sync-service';

afterEach(() => vi.restoreAllMocks());

function integration(tenantId: string) {
  return { id: `int-${tenantId}`, tenantId, provider: 'quickbooks', status: 'active' };
}

describe('accounting sync sweep — QuickBooks is Growth-only', () => {
  it('syncs Growth tenants and skips a tenant that is no longer on Growth', async () => {
    const synced = vi
      .spyOn(AccountingSyncService.prototype, 'syncIntegration')
      .mockResolvedValue({ pushedInvoices: 1, skippedInvoices: 0, failedInvoices: 0 } as never);
    const plans: Record<string, 'starter' | 'growth'> = { t_growth: 'growth', t_starter: 'starter' };

    const result = await runAccountingSyncSweep({
      integrationRepo: { findAllActive: async () => [integration('t_growth'), integration('t_starter')] },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      planForTenant: async (tenantId: string) => plans[tenantId],
    } as never);

    expect(synced).toHaveBeenCalledTimes(1);
    expect(synced.mock.calls[0][0]).toMatchObject({ tenantId: 't_growth' });
    expect(result.pushed).toBe(1);
  });
});
