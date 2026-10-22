import { describe, it, expect, vi } from 'vitest';
import { runDripCampaignSweep } from '../../src/workers/drip-campaign-worker';

const logger = { info: vi.fn(), error: vi.fn() };

describe('runDripCampaignSweep', () => {
  it('skips tenants without the flag (off by default) and sums the rest', async () => {
    const runTenant = vi.fn(async () => 2);
    const result = await runDripCampaignSweep({
      listTenantIds: async () => ['on-1', 'off', 'on-2'],
      isEnabledForTenant: async (id) => id.startsWith('on'),
      engine: { runTenant },
      logger,
    });
    expect(runTenant).toHaveBeenCalledTimes(2);
    expect(runTenant).not.toHaveBeenCalledWith('off');
    expect(result).toEqual({ tenants: 2, processed: 4 });
  });

  it('one tenant failing does not stop the others', async () => {
    const runTenant = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return 1;
    });
    const result = await runDripCampaignSweep({
      listTenantIds: async () => ['bad', 'good'],
      isEnabledForTenant: async () => true,
      engine: { runTenant },
      logger,
    });
    expect(result.processed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith('Drip campaign sweep failed for tenant', expect.objectContaining({ tenantId: 'bad' }));
  });
});
