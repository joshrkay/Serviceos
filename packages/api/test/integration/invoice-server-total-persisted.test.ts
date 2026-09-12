/**
 * I9 (#1020, lane A) — "createInvoice persists the server total, discarding
 * the client's" (P0-2), proven against real Postgres.
 *
 * `test/shared/line-item-normalization.test.ts` proves `createInvoice`
 * recomputes a divergent client-supplied line total and returns the
 * server-corrected `Invoice` object — but only against
 * `InMemoryInvoiceRepository`. `test/integration/invoices.test.ts` (real
 * Postgres) never exercises `createInvoice` at all — it pre-builds
 * already-correct totals and calls `PgInvoiceRepository.create()` directly,
 * bypassing `normalizeLineItemTotals`/`calculateDocumentTotals` entirely.
 * This file closes that gap: `createInvoice` is called with a real
 * `PgInvoiceRepository`, and the row is read back from Postgres (not just
 * the returned object) to prove the SERVER value — not the client's — is
 * what actually persisted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { createInvoice } from '../../src/invoices/invoice';
import { calculateLineItemTotal, LineItem } from '../../src/shared/billing-engine';

/** A line as the float-dollar web client would send it (wrong totalCents). */
function clientLine(quantity: number, unitPriceCents: number, clientTotalCents: number): LineItem {
  return {
    id: crypto.randomUUID(),
    description: 'Fractional-quantity line',
    quantity,
    unitPriceCents,
    totalCents: clientTotalCents,
    sortOrder: 0,
    taxable: true,
  };
}

// The empirically confirmed float-vs-integer divergence from P0-2: the web
// client computes `round(qty * (unitPriceCents/100) * 100)` = 14, the server
// formula `round(qty * unitPriceCents)` = 15.
const QUANTITY = 0.5;
const UNIT_PRICE_CENTS = 29;
const CLIENT_TOTAL_CENTS = 14;
const SERVER_TOTAL_CENTS = 15;

async function seedJob(pool: Pool, tenantId: string, userId: string): Promise<string> {
  const customerRepo = new PgCustomerRepository(pool);
  const locationRepo = new PgLocationRepository(pool);
  const jobRepo = new PgJobRepository(pool);

  const customerId = crypto.randomUUID();
  await customerRepo.create({
    id: customerId,
    tenantId,
    firstName: 'Server',
    lastName: 'Total',
    displayName: 'Server Total',
    preferredChannel: 'phone',
    smsConsent: false,
    isArchived: false,
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const locationId = crypto.randomUUID();
  await locationRepo.create({
    id: locationId,
    tenantId,
    customerId,
    street1: '1 Server Total Way',
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
    tenantId,
    customerId,
    locationId,
    jobNumber: `JOB-I9-${jobId.slice(0, 8)}`,
    summary: 'I9 server-total job',
    status: 'scheduled',
    priority: 'normal',
    createdBy: userId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return jobId;
}

describe('I9 — createInvoice persists the server total, discarding the client\'s, at real Postgres', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('the client-supplied line total is discarded; the persisted row carries the server-recomputed total', async () => {
    expect(calculateLineItemTotal(QUANTITY, UNIT_PRICE_CENTS)).toBe(SERVER_TOTAL_CENTS);

    const tenant = await createTestTenant(pool);
    const jobId = await seedJob(pool, tenant.tenantId, tenant.userId);

    const invoice = await createInvoice(
      {
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: 'INV-I9-1',
        // The client's float-math line total (14¢) — the truth is 15¢.
        lineItems: [clientLine(QUANTITY, UNIT_PRICE_CENTS, CLIENT_TOTAL_CENTS)],
        createdBy: tenant.userId,
      },
      invoiceRepo,
    );

    // The returned object already carries the server value...
    expect(invoice.lineItems[0].totalCents).toBe(SERVER_TOTAL_CENTS);
    expect(invoice.totals.totalCents).toBe(SERVER_TOTAL_CENTS);
    expect(invoice.amountDueCents).toBe(SERVER_TOTAL_CENTS);

    // ...but the real proof is what's actually IN Postgres, read back
    // through a completely independent path (raw SQL, not the repo that
    // just wrote it).
    const lineRows = await pool.query(
      `SELECT total_cents FROM invoice_line_items WHERE invoice_id = $1 AND tenant_id = $2`,
      [invoice.id, tenant.tenantId],
    );
    expect(lineRows.rows).toHaveLength(1);
    expect(lineRows.rows[0].total_cents).toBe(SERVER_TOTAL_CENTS);
    expect(lineRows.rows[0].total_cents).not.toBe(CLIENT_TOTAL_CENTS);

    const invoiceRows = await pool.query(
      `SELECT total_cents, amount_due_cents FROM invoices WHERE id = $1 AND tenant_id = $2`,
      [invoice.id, tenant.tenantId],
    );
    expect(invoiceRows.rows[0].total_cents).toBe(SERVER_TOTAL_CENTS);
    expect(invoiceRows.rows[0].amount_due_cents).toBe(SERVER_TOTAL_CENTS);

    // A fresh repository read (a brand-new PgInvoiceRepository instance)
    // agrees — the server total is durable, not an artifact of the
    // in-process object returned by createInvoice.
    const reread = await new PgInvoiceRepository(pool).findById(tenant.tenantId, invoice.id);
    expect(reread!.lineItems[0].totalCents).toBe(SERVER_TOTAL_CENTS);
    expect(reread!.totals.totalCents).toBe(SERVER_TOTAL_CENTS);
  });

  it('T1 — a second tenant\'s correctly-totaled invoice is unaffected by the first tenant\'s client-total discard', async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    const jobA = await seedJob(pool, tenantA.tenantId, tenantA.userId);
    const jobB = await seedJob(pool, tenantB.tenantId, tenantB.userId);

    const invoiceA = await createInvoice(
      {
        tenantId: tenantA.tenantId,
        jobId: jobA,
        invoiceNumber: 'INV-I9-TENANT-A',
        lineItems: [clientLine(QUANTITY, UNIT_PRICE_CENTS, CLIENT_TOTAL_CENTS)],
        createdBy: tenantA.userId,
      },
      invoiceRepo,
    );
    // Tenant B sends an ALREADY-correct total for a whole-quantity line —
    // no divergence to fix, so its total should be untouched by whatever
    // happened to tenant A's line.
    const invoiceB = await createInvoice(
      {
        tenantId: tenantB.tenantId,
        jobId: jobB,
        invoiceNumber: 'INV-I9-TENANT-B',
        lineItems: [clientLine(2, 5_000, 10_000)],
        createdBy: tenantB.userId,
      },
      invoiceRepo,
    );

    expect(invoiceA.totals.totalCents).toBe(SERVER_TOTAL_CENTS);
    expect(invoiceB.totals.totalCents).toBe(10_000);

    // Cross-tenant fetch fails, and each tenant's persisted row carries
    // only its own total.
    expect(await invoiceRepo.findById(tenantB.tenantId, invoiceA.id)).toBeNull();
    expect(await invoiceRepo.findById(tenantA.tenantId, invoiceB.id)).toBeNull();

    const rowA = await pool.query(`SELECT total_cents FROM invoices WHERE id = $1`, [invoiceA.id]);
    const rowB = await pool.query(`SELECT total_cents FROM invoices WHERE id = $1`, [invoiceB.id]);
    expect(rowA.rows[0].total_cents).toBe(SERVER_TOTAL_CENTS);
    expect(rowB.rows[0].total_cents).toBe(10_000);
  });
});
