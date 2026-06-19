/**
 * Postgres integration — QuickBooks sync (F17 / P15-001).
 *
 * Drives runAccountingSyncSweep against the production Pg repos for
 * accounting_integrations and accounting_sync_log with mocked QuickBooks
 * HTTP responses. Same pattern as the calendar / dropped-call / reviews
 * closures: real Pg writes for the durable bits + a fetchFn seam.
 *
 * What this pins (the unit test cannot):
 *
 *   1. PgAccountingIntegrationRepository.upsert — encrypted tokens land
 *      under RLS + ON CONFLICT (tenant_id).
 *   2. PgAccountingSyncLogRepository.create / findSuccessfulPush /
 *      findExternalIdForEntity — payload_hash + entity_id + external_id
 *      round-trip through the schema; the dedupe path is what makes
 *      sweep #2 a no-op.
 *   3. RLS on accounting_sync_log — cross-tenant queries return zero.
 *   4. Cross-tenant cursor: AccountingSyncService.syncIntegration runs
 *      under the right tenant for each integration in findAllActive's
 *      cross-tenant lookup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { closeSharedTestDb, createTestTenant, getSharedTestDb } from './shared';
import { runAccountingSyncSweep } from '../../src/workers/accounting-sync-worker';
import {
  PgAccountingIntegrationRepository,
  PgAccountingSyncLogRepository,
} from '../../src/integrations/accounting/repository';
import type { QuickBooksFetch } from '../../src/integrations/accounting/quickbooks-oauth';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createLogger } from '../../src/logging/logger';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const logger = createLogger({ service: 'test', environment: 'test', level: 'error' });

// 64-hex-char AES-256-GCM key for TENANT_ENCRYPTION_KEY.
const TEST_ENC_KEY = '0011223344556677889900112233445566778899001122334455667788990011';

const QBO_CONFIG = {
  clientId: 'qbo-client',
  clientSecret: 'qbo-secret',
  redirectUri: 'http://localhost/oauth/qbo/callback',
  environment: 'sandbox' as const,
};

interface QbCall {
  url: string;
  body: Record<string, unknown> | null;
}

/**
 * Mocked QuickBooks fetch. Routes by URL substring:
 *   POST /customer       -> returns { Customer: { Id: 'qb_cust_<n>' } }
 *   POST /salesreceipt   -> returns { SalesReceipt: { Id: 'qb_sr_<n>' } }
 *
 * `forceError` lets a test fail one of the calls with an HTTP 4xx.
 */
function makeQboFetch(opts?: {
  forceError?: { onPath: 'customer' | 'salesreceipt'; status: number; message: string };
}): { fetchFn: QuickBooksFetch; calls: QbCall[] } {
  const calls: QbCall[] = [];
  let customerN = 0;
  let receiptN = 0;
  const fetchFn: QuickBooksFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });

    const isCustomer = url.includes('/customer');
    const isReceipt = url.includes('/salesreceipt');
    if (opts?.forceError) {
      if (
        (opts.forceError.onPath === 'customer' && isCustomer) ||
        (opts.forceError.onPath === 'salesreceipt' && isReceipt)
      ) {
        return {
          ok: false,
          status: opts.forceError.status,
          headers: { get: () => null },
          async json() {
            return { Fault: { Error: [{ Message: opts.forceError!.message }] } };
          },
        } as unknown as Response;
      }
    }
    if (isCustomer) {
      customerN++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { Customer: { Id: `qb_cust_${customerN}` } };
        },
      } as unknown as Response;
    }
    if (isReceipt) {
      receiptN++;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async json() {
          return { SalesReceipt: { Id: `qb_sr_${receiptN}` } };
        },
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      async json() {
        return { Fault: { Error: [{ Message: 'unknown path' }] } };
      },
    } as unknown as Response;
  }) as QuickBooksFetch;
  return { fetchFn, calls };
}

describe('QuickBooks accounting sync — integration', () => {
  let pool: Pool;
  let integrationRepo: PgAccountingIntegrationRepository;
  let syncLogRepo: PgAccountingSyncLogRepository;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenantA: { tenantId: string; userId: string };

  beforeAll(async () => {
    process.env.TENANT_ENCRYPTION_KEY = TEST_ENC_KEY;
    pool = await getSharedTestDb();
    integrationRepo = new PgAccountingIntegrationRepository(pool);
    syncLogRepo = new PgAccountingSyncLogRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
  });

  beforeEach(async () => {
    tenantA = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  async function seedActiveIntegration(tenantId: string): Promise<string> {
    const integration = await integrationRepo.upsert({
      tenantId,
      provider: 'quickbooks',
      accessToken: 'qbo-access-token',
      refreshToken: 'qbo-refresh-token',
      realmId: `realm_${tenantId.slice(0, 8)}`,
    });
    return integration.id;
  }

  async function seedCustomerJobLocation(
    tenant: { tenantId: string; userId: string },
    customerName: string,
  ): Promise<{ customerId: string; jobId: string }> {
    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: customerName,
      lastName: 'Tester',
      displayName: `${customerName} Tester`,
      email: `${customerName.toLowerCase()}@example.com`,
      primaryPhone: '+15555550100',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 QB St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${customerId.slice(0, 8)}`,
      summary: 'QB sync job',
      status: 'completed',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { customerId, jobId };
  }

  async function seedPaidInvoice(
    tenant: { tenantId: string; userId: string },
    jobId: string,
    invoiceNumber: string,
    totalCents = 12500,
  ): Promise<string> {
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 1, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber,
      status: 'paid',
      lineItems,
      totals,
      amountPaidCents: totals.totalCents,
      amountDueCents: 0,
      issuedAt: new Date('2026-06-19T15:00:00.000Z'),
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return invoiceId;
  }

  it('happy path: sweep pushes one customer + one sales receipt; sync_log records both as success', async () => {
    const integrationId = await seedActiveIntegration(tenantA.tenantId);
    const { customerId, jobId } = await seedCustomerJobLocation(tenantA, 'Alice');
    const invoiceId = await seedPaidInvoice(tenantA, jobId, 'INV-A-001');
    const { fetchFn, calls } = makeQboFetch();

    const result = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn,
      logger,
    });

    expect(result.integrations).toBeGreaterThanOrEqual(1);
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);

    // Exactly one customer + one receipt call to QuickBooks.
    const customerCalls = calls.filter((c) => c.url.includes('/customer'));
    const receiptCalls = calls.filter((c) => c.url.includes('/salesreceipt'));
    expect(customerCalls).toHaveLength(1);
    expect(receiptCalls).toHaveLength(1);
    expect((receiptCalls[0].body as Record<string, unknown>).DocNumber).toBe('INV-A-001');

    // sync_log rows are persisted under the tenant via withTenant.
    const recent = await syncLogRepo.listRecent(tenantA.tenantId, integrationId, 50);
    const customerLogs = recent.filter((l) => l.entityType === 'customer' && l.entityId === customerId);
    const invoiceLogs = recent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceId);
    expect(customerLogs.some((l) => l.status === 'success' && l.externalId === 'qb_cust_1')).toBe(true);
    expect(invoiceLogs.some((l) => l.status === 'success' && l.externalId === 'qb_sr_1')).toBe(true);
  });

  it('idempotent on re-sweep: a second sweep finds an existing successful push and skips QB entirely', async () => {
    await seedActiveIntegration(tenantA.tenantId);
    const { jobId } = await seedCustomerJobLocation(tenantA, 'Bob');
    await seedPaidInvoice(tenantA, jobId, 'INV-B-001');
    const { fetchFn: fetchFn1 } = makeQboFetch();

    const first = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn: fetchFn1,
      logger,
    });
    expect(first.pushed).toBeGreaterThanOrEqual(1);

    const { fetchFn: fetchFn2, calls: calls2 } = makeQboFetch();
    const second = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn: fetchFn2,
      logger,
    });
    // The successful-push lookup deduped the invoice. QB should not have
    // been called for the receipt path on the second sweep.
    expect(second.pushed).toBe(0);
    expect(calls2.filter((c) => c.url.includes('/salesreceipt'))).toHaveLength(0);
  });

  it('customer cache: two paid invoices for the same customer trigger ONE QuickBooks customer create, TWO sales receipts', async () => {
    await seedActiveIntegration(tenantA.tenantId);
    const { jobId } = await seedCustomerJobLocation(tenantA, 'Cathy');
    await seedPaidInvoice(tenantA, jobId, 'INV-C-001', 10000);
    await seedPaidInvoice(tenantA, jobId, 'INV-C-002', 20000);
    const { fetchFn, calls } = makeQboFetch();

    const result = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn,
      logger,
    });
    expect(result.pushed).toBe(2);
    const customerCalls = calls.filter((c) => c.url.includes('/customer'));
    const receiptCalls = calls.filter((c) => c.url.includes('/salesreceipt'));
    expect(customerCalls).toHaveLength(1);
    expect(receiptCalls).toHaveLength(2);
  });

  it('failure path: QuickBooks 4xx on the receipt is captured as a failed sync_log row (caller is never thrown to)', async () => {
    const integrationId = await seedActiveIntegration(tenantA.tenantId);
    const { jobId } = await seedCustomerJobLocation(tenantA, 'Dan');
    const invoiceId = await seedPaidInvoice(tenantA, jobId, 'INV-D-001');
    const { fetchFn } = makeQboFetch({
      forceError: { onPath: 'salesreceipt', status: 422, message: 'invalid line amount' },
    });

    const result = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn,
      logger,
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.pushed).toBe(0);

    const recent = await syncLogRepo.listRecent(tenantA.tenantId, integrationId, 50);
    const logs = recent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceId);
    expect(logs.some((l) => l.status === 'failed' && (l.errorMessage ?? '').includes('invalid'))).toBe(
      true,
    );
  });

  it('tenant isolation: sync_log rows written under tenant A are invisible to tenant B (RLS)', async () => {
    const tenantB = await createTestTenant(pool);
    const integrationA = await seedActiveIntegration(tenantA.tenantId);
    const integrationB = await seedActiveIntegration(tenantB.tenantId);
    const { jobId: jobA } = await seedCustomerJobLocation(tenantA, 'IsoA');
    const { jobId: jobB } = await seedCustomerJobLocation(tenantB, 'IsoB');
    const invoiceA = await seedPaidInvoice(tenantA, jobA, 'INV-ISO-A');
    const invoiceB = await seedPaidInvoice(tenantB, jobB, 'INV-ISO-B');
    const { fetchFn } = makeQboFetch();

    const result = await runAccountingSyncSweep({
      integrationRepo,
      syncLogRepo,
      invoiceRepo,
      customerRepo,
      jobRepo,
      qboConfig: QBO_CONFIG,
      fetchFn,
      logger,
    });
    expect(result.pushed).toBeGreaterThanOrEqual(2);

    // Tenant A's listRecent (run under tenant A's GUC) sees invoice A
    // but NOT invoice B. RLS is what proves this — listRecent passes
    // through withTenant and the policy gates the read.
    const aRecent = await syncLogRepo.listRecent(tenantA.tenantId, integrationA, 100);
    const aLogsForA = aRecent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceA);
    const aLogsForB = aRecent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceB);
    expect(aLogsForA.some((l) => l.status === 'success')).toBe(true);
    expect(aLogsForB).toHaveLength(0);

    // Symmetric check from tenant B.
    const bRecent = await syncLogRepo.listRecent(tenantB.tenantId, integrationB, 100);
    const bLogsForB = bRecent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceB);
    const bLogsForA = bRecent.filter((l) => l.entityType === 'invoice' && l.entityId === invoiceA);
    expect(bLogsForB.some((l) => l.status === 'success')).toBe(true);
    expect(bLogsForA).toHaveLength(0);
  });
});
