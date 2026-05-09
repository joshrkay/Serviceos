import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — payments', () => {
  let pool: Pool;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    paymentRepo = new PgPaymentRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Test',
      lastName: 'Customer',
      displayName: 'Test Customer',
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
      customerId: customerId,
      street1: '123 Main St',
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
      customerId: customerId,
      locationId: locationId,
      jobNumber: 'JOB-001',
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Labor', 2, 7500, 1, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 825);

    invoiceId = crypto.randomUUID();
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId: jobId,
      invoiceNumber: 'INV-001',
      status: 'open',
      lineItems: lineItems,
      totals: totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates payment and retrieves via findById', async () => {
      const payment = await paymentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        invoiceId: invoiceId,
        amountCents: 15000,
        method: 'stripe',
        status: 'completed',
        receivedAt: new Date(),
        processedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await paymentRepo.findById(tenant.tenantId, payment.id);
      expect(found).not.toBeNull();
      expect(found!.amountCents).toBe(15000);
      expect(found!.status).toBe('completed');
      expect(found!.invoiceId).toBe(invoiceId);
    });

    it('finds payments by invoice', async () => {
      await paymentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        invoiceId: invoiceId,
        amountCents: 5000,
        method: 'cash',
        status: 'completed',
        receivedAt: new Date(),
        processedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
      expect(payments.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const payment = await paymentRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        invoiceId: invoiceId,
        amountCents: 99999,
        method: 'stripe',
        status: 'completed',
        receivedAt: new Date(),
        processedBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await paymentRepo.findById(otherTenant.tenantId, payment.id);
      expect(found).toBeNull();
    });
  });
});