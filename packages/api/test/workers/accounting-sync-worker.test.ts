import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { runAccountingSyncSweep } from '../../src/workers/accounting-sync-worker';
import {
  InMemoryAccountingIntegrationRepository,
  InMemoryAccountingSyncLogRepository,
} from '../../src/integrations/accounting/repository';
import { InMemoryInvoiceRepository } from '../../src/invoices/invoice';
import { InMemoryCustomerRepository } from '../../src/customers/customer';
import { InMemoryJobRepository } from '../../src/jobs/job';
import { createLogger } from '../../src/logging/logger';

const TEST_KEY = '0'.repeat(64);

describe('accounting-sync-worker (F17)', () => {
  beforeAll(() => {
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    delete process.env.TENANT_ENCRYPTION_KEY;
  });

  it('sweep processes active integrations without throwing', async () => {
    const integrationRepo = new InMemoryAccountingIntegrationRepository();
    await integrationRepo.upsert({
      tenantId: 'tenant-1',
      provider: 'quickbooks',
      accessToken: 'tok',
      refreshToken: 'ref',
      realmId: 'realm-1',
    });

    const result = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo: new InMemoryAccountingSyncLogRepository(),
      invoiceRepo: new InMemoryInvoiceRepository(),
      customerRepo: new InMemoryCustomerRepository(),
      jobRepo: new InMemoryJobRepository(),
      qboConfig: {
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/cb',
      },
      fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch,
      logger: createLogger({ service: 'test', environment: 'test' }),
    });

    expect(result.integrations).toBe(1);
  });
});
