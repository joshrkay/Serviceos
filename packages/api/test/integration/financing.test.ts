import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgFinancingRepository } from '../../src/financing/pg-financing';
import {
  applyFinancingStatusUpdate,
  offerFinancing,
} from '../../src/financing/financing';
import { ManualFinancingProvider } from '../../src/financing/financing-provider';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — consumer financing (migration 225)', () => {
  let pool: Pool;
  let repo: PgFinancingRepository;
  let tenant: { tenantId: string; userId: string };
  let customerId: string;
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    repo = new PgFinancingRepository(pool);
    tenant = await createTestTenant(pool);

    const customers = new PgCustomerRepository(pool);
    const locations = new PgLocationRepository(pool);
    const jobs = new PgJobRepository(pool);
    const invoices = new PgInvoiceRepository(pool);

    customerId = randomUUID();
    await customers.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Fin',
      lastName: 'Customer',
      displayName: 'Fin Customer',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = randomUUID();
    await locations.create({
      id: locationId,
      tenantId: tenant.tenantId,
      customerId,
      street1: '1 Elm',
      city: 'Akron',
      state: 'OH',
      postalCode: '44301',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const jobId = randomUUID();
    await jobs.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Financing job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lineItems = [buildLineItem(randomUUID(), 'Service', 1, 250_00, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    invoiceId = randomUUID();
    await invoices.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      status: 'open',
      lineItems,
      totals,
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

  it('persists a financing application with real columns and round-trips status', async () => {
    const app = await offerFinancing(
      {
        tenantId: tenant.tenantId,
        invoiceId,
        customerId,
        amountCents: 250_00,
        invoiceNumber: 'INV-1',
        customerName: 'Fin Customer',
        createdBy: tenant.userId,
      },
      repo,
      new ManualFinancingProvider()
    );

    const { rows } = await pool.query(
      `SELECT tenant_id, invoice_id, customer_id, amount_cents, provider, status
         FROM financing_applications WHERE id = $1`,
      [app.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(tenant.tenantId);
    expect(rows[0].invoice_id).toBe(invoiceId);
    expect(rows[0].customer_id).toBe(customerId);
    expect(Number(rows[0].amount_cents)).toBe(250_00);
    expect(rows[0].provider).toBe('manual');
    expect(rows[0].status).toBe('offered');

    const updated = await applyFinancingStatusUpdate(
      tenant.tenantId,
      app.id,
      'approved',
      'auto',
      repo
    );
    expect(updated?.status).toBe('approved');

    const byInvoice = await repo.listByInvoice(tenant.tenantId, invoiceId);
    expect(byInvoice.map((a) => a.id)).toContain(app.id);
  });

  it('does not leak applications across tenants (RLS)', async () => {
    const app = await offerFinancing(
      {
        tenantId: tenant.tenantId,
        invoiceId,
        customerId,
        amountCents: 250_00,
        invoiceNumber: 'INV-1',
        customerName: 'Fin Customer',
        createdBy: tenant.userId,
      },
      repo,
      new ManualFinancingProvider()
    );
    const other = await createTestTenant(pool);
    expect(await repo.findById(other.tenantId, app.id)).toBeNull();
    expect(await repo.listByInvoice(other.tenantId, invoiceId)).toEqual([]);
  });
});
