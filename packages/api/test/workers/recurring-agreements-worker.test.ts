import { describe, it, expect, vi } from 'vitest';
import { runRecurringAgreementsSweep } from '../../src/workers/recurring-agreements-worker';
import { InMemoryAgreementRepository } from '../../src/agreements/agreement';
import { InMemoryAgreementRunRepository } from '../../src/agreements/agreement-run';
import { createAgreement } from '../../src/agreements/agreement-service';
import { createLogger } from '../../src/logging/logger';

describe('P9-003 recurring-agreements-worker', () => {
  it('iterates tenants and calls runDueAgreements per tenant', async () => {
    const agreementRepo = new InMemoryAgreementRepository();
    const runRepo = new InMemoryAgreementRunRepository();
    const tenantA = '11111111-1111-1111-1111-111111111111';
    const tenantB = '22222222-2222-2222-2222-222222222222';
    const created: string[] = [];
    const jobsService = {
      async createJob(input: { tenantId: string }) {
        created.push(`job:${input.tenantId}`);
        return { id: `job-${created.length}` };
      },
    };
    const invoicesService = {
      async createDraftInvoice(input: { tenantId: string }) {
        created.push(`inv:${input.tenantId}`);
        return { id: `inv-${created.length}` };
      },
    };

    for (const t of [tenantA, tenantB]) {
      await createAgreement(
        {
          tenantId: t,
          customerId: '00000000-0000-0000-0000-000000000001',
          name: 'x',
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
          priceCents: 100,
          startsOn: '2020-01-01',
          createdBy: 'u',
        },
        agreementRepo,
      );
    }

    const listTenantIds = vi.fn().mockResolvedValue([tenantA, tenantB]);
    const result = await runRecurringAgreementsSweep({
      agreementRepo,
      runRepo,
      jobsService,
      invoicesService,
      listTenantIds,
      logger: createLogger({ service: 'test', environment: 'test' }),
    });

    expect(listTenantIds).toHaveBeenCalledOnce();
    expect(result.tenants).toBe(2);
    expect(result.generated).toBe(2);
    expect(created).toContain(`job:${tenantA}`);
    expect(created).toContain(`job:${tenantB}`);
  });

  it('does not crash when a tenant lookup fails', async () => {
    const result = await runRecurringAgreementsSweep({
      agreementRepo: new InMemoryAgreementRepository(),
      runRepo: new InMemoryAgreementRunRepository(),
      jobsService: { async createJob() { return { id: 'x' }; } },
      invoicesService: { async createDraftInvoice() { return { id: 'x' }; } },
      listTenantIds: async () => {
        throw new Error('db unavailable');
      },
      logger: createLogger({ service: 'test', environment: 'test' }),
    });
    expect(result).toEqual({ tenants: 0, generated: 0, skipped: 0, failed: 0 });
  });
});
