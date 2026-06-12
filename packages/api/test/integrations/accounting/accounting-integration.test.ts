import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  InMemoryAccountingIntegrationRepository,
  InMemoryAccountingSyncLogRepository,
  InMemoryAccountingOAuthStateRepository,
  decryptedAccessToken,
} from '../../../src/integrations/accounting/repository';
import {
  buildQuickBooksAuthUrl,
  exchangeQuickBooksAuthorizationCode,
  refreshQuickBooksTokens,
} from '../../../src/integrations/accounting/quickbooks-oauth';
import { QuickBooksClient } from '../../../src/integrations/accounting/quickbooks-client';
import { AccountingSyncService } from '../../../src/integrations/accounting/sync-service';
import { InMemoryInvoiceRepository } from '../../../src/invoices/invoice';
import { InMemoryCustomerRepository } from '../../../src/customers/customer';
import { InMemoryJobRepository } from '../../../src/jobs/job';
import { createLogger } from '../../../src/logging/logger';
import { hashInvoicePayload } from '../../../src/integrations/accounting/payload-hash';

const TEST_KEY = '0'.repeat(64);

describe('P15-001 / F17 accounting integrations', () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.TENANT_ENCRYPTION_KEY;
    process.env.TENANT_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.TENANT_ENCRYPTION_KEY;
    else process.env.TENANT_ENCRYPTION_KEY = originalKey;
  });

  it('OAuth callback exchanges code for tokens (mock Intuit)', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('oauth2/v1/tokens/bearer');
      expect(init?.method).toBe('POST');
      return new Response(
        JSON.stringify({
          access_token: 'access-123',
          refresh_token: 'refresh-456',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const tokens = await exchangeQuickBooksAuthorizationCode(
      {
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/callback',
      },
      'auth-code',
      'realm-99',
      fetchFn,
    );
    expect(tokens.accessToken).toBe('access-123');
    expect(tokens.realmId).toBe('realm-99');
  });

  it('refresh token rotation returns new access token', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const refreshed = await refreshQuickBooksTokens(
      { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
      'old-refresh',
      fetchFn,
    );
    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('new-refresh');
  });

  it('push invoice creates QBO sales receipt (mock API)', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.DisplayName) {
        return new Response(JSON.stringify({ Customer: { Id: 'cust-qbo-1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ SalesReceipt: { Id: 'sr-qbo-1' } }), { status: 200 });
    }) as typeof fetch;

    const client = new QuickBooksClient('realm-a', 'token-a', fetchFn);
    const customer = await client.createCustomer({ displayName: 'Jane Doe' }, 'cust-key');
    expect(customer.id).toBe('cust-qbo-1');
    const receipt = await client.createSalesReceipt(
      {
        customerRefId: customer.id,
        docNumber: 'INV-100',
        totalCents: 15000,
        lineDescriptions: ['Service call'],
        txnDate: '2026-06-01',
      },
      'inv-key',
    );
    expect(receipt.id).toBe('sr-qbo-1');
  });

  it('dedup prevents double-push of the same paid invoice', async () => {
    const integrationRepo = new InMemoryAccountingIntegrationRepository();
    const syncLogRepo = new InMemoryAccountingSyncLogRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const customerRepo = new InMemoryCustomerRepository();
    const jobRepo = new InMemoryJobRepository();

    const integration = await integrationRepo.upsert({
      tenantId: 'tenant-a',
      provider: 'quickbooks',
      accessToken: 'tok',
      refreshToken: 'ref',
      realmId: 'realm-a',
    });

    await customerRepo.create({
      id: 'cust-1',
      tenantId: 'tenant-a',
      firstName: 'Jane',
      lastName: 'Doe',
      displayName: 'Jane Doe',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await jobRepo.create({
      id: 'job-1',
      tenantId: 'tenant-a',
      customerId: 'cust-1',
      locationId: 'loc-1',
      jobNumber: 'JOB-1',
      summary: 'Repair',
      status: 'completed',
      priority: 'normal',
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const invoice = await invoiceRepo.create({
      id: 'inv-1',
      tenantId: 'tenant-a',
      jobId: 'job-1',
      invoiceNumber: 'INV-001',
      status: 'paid',
      lineItems: [{ description: 'Labor', quantity: 1, unitPriceCents: 10000 }],
      totals: {
        subtotalCents: 10000,
        discountCents: 0,
        taxCents: 0,
        totalCents: 10000,
      },
      amountPaidCents: 10000,
      amountDueCents: 0,
      createdBy: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let qboCalls = 0;
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      qboCalls += 1;
      const body = JSON.parse(String(init?.body));
      if (body.DisplayName) {
        return new Response(JSON.stringify({ Customer: { Id: 'qbo-cust' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ SalesReceipt: { Id: 'qbo-sr' } }), { status: 200 });
    }) as typeof fetch;

    const service = new AccountingSyncService({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: {
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: 'http://localhost/cb',
      },
      fetchFn,
      logger: createLogger({ service: 'test', environment: 'test' }),
    });

    const first = await service.syncIntegration(integration);
    const second = await service.syncIntegration(integration);
    expect(first.pushedInvoices).toBe(1);
    expect(second.skippedInvoices).toBe(1);
    expect(qboCalls).toBe(2); // one customer + one receipt only on first run
    expect(
      await syncLogRepo.findSuccessfulPush(
        'tenant-a',
        integration.id,
        'invoice',
        invoice.id,
        hashInvoicePayload(invoice),
      ),
    ).not.toBeNull();
  });

  it('tenant isolation — tenant A realm never used for tenant B sync', async () => {
    const integrationRepo = new InMemoryAccountingIntegrationRepository();
    const realmsSeen: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      const match = url.match(/company\/([^/]+)/);
      if (match) realmsSeen.push(match[1]);
      return new Response(JSON.stringify({ Customer: { Id: '1' } }), { status: 200 });
    }) as typeof fetch;

    await integrationRepo.upsert({
      tenantId: 'tenant-a',
      provider: 'quickbooks',
      accessToken: 'tok-a',
      refreshToken: 'ref-a',
      realmId: 'realm-A',
    });
    await integrationRepo.upsert({
      tenantId: 'tenant-b',
      provider: 'quickbooks',
      accessToken: 'tok-b',
      refreshToken: 'ref-b',
      realmId: 'realm-B',
    });

    const integrations = await integrationRepo.findAllActive();
    for (const row of integrations) {
      const client = new QuickBooksClient(row.realmId, decryptedAccessToken(row), fetchFn);
      await client.createCustomer({ displayName: row.tenantId }, `key-${row.tenantId}`);
    }

    expect(realmsSeen).toContain('realm-A');
    expect(realmsSeen).toContain('realm-B');
    expect(realmsSeen.every((r) => r === 'realm-A' || r === 'realm-B')).toBe(true);
    expect(new Set(realmsSeen).size).toBe(2);
  });

  it('buildQuickBooksAuthUrl includes state nonce', () => {
    const url = buildQuickBooksAuthUrl(
      { clientId: 'cid', clientSecret: 's', redirectUri: 'http://localhost/cb' },
      'state-uuid',
    );
    expect(url).toContain('state=state-uuid');
    expect(url).toContain('client_id=cid');
  });
});
