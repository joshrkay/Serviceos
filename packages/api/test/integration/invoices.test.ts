import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — invoices', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
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

    jobId = crypto.randomUUID();
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
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  describe('CRUD', () => {
    it('creates invoice and retrieves via findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 2, 7500, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const invoice = await invoiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        invoiceNumber: 'INV-001',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await invoiceRepo.findById(tenant.tenantId, invoice.id);
      expect(found).not.toBeNull();
      expect(found!.status).toBe('draft');
      expect(found!.invoiceNumber).toBe('INV-001');
      expect(found!.lineItems).toHaveLength(1);
    });

    it('round-trips the processing-fee surcharge columns (migration 202)', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(), 'Labor', 1, 10000, 1, true, 'labor'),
      ];
      // 3% surcharge → fee folded into total_cents + the dedicated columns.
      const totals = calculateDocumentTotals(lineItems, 0, 0, 300);
      expect(totals.processingFeeCents).toBe(300);

      const invoice = await invoiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: 'INV-FEE-1',
        status: 'draft',
        lineItems,
        totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await invoiceRepo.findById(tenant.tenantId, invoice.id);
      expect(found!.totals.processingFeeBps).toBe(300);
      expect(found!.totals.processingFeeCents).toBe(300);
      expect(found!.totals.totalCents).toBe(10300);
      expect(found!.amountDueCents).toBe(10300);
    });

    it('updates invoice and reflects in findById', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 5000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const invoice = await invoiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        invoiceNumber: 'INV-002',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await invoiceRepo.update(tenant.tenantId, invoice.id, {
        status: 'open',
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('open');

      const found = await invoiceRepo.findById(tenant.tenantId, invoice.id);
      expect(found!.status).toBe('open');
    });

    it('finds invoices by tenant', async () => {
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Labor', 1, 3000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      await invoiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        invoiceNumber: 'INV-003',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const invoices = await invoiceRepo.findByTenant(tenant.tenantId);
      expect(invoices.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('tenant isolation', () => {
    it('rejects cross-tenant access', async () => {
      const otherTenant = await createTestTenant(pool);
      const lineItems = [
        buildLineItem(crypto.randomUUID(),'Secret Labor', 1, 10000, 1, true, 'labor'),
      ];
      const totals = calculateDocumentTotals(lineItems, 0, 825);

      const invoice = await invoiceRepo.create({
        id: crypto.randomUUID(),
        tenantId: tenant.tenantId,
        jobId: jobId,
        invoiceNumber: 'INV-SECRET',
        status: 'draft',
        lineItems: lineItems,
        totals: totals,
        amountPaidCents: 0,
        amountDueCents: totals.totalCents,
        createdBy: tenant.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const found = await invoiceRepo.findById(otherTenant.tenantId, invoice.id);
      expect(found).toBeNull();
    });
  });
});