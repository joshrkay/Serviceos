/**
 * Postgres integration — invoice_line_items.pricing_source (migration 255).
 *
 * pricingSource provenance (catalog | ambiguous | uncatalogued | manual)
 * was persisted for ESTIMATE lines but DROPPED for INVOICE lines, so
 * invoice audit trails couldn't show where a price came from. This pins
 * the REAL column round-trip against Postgres — a mocked-DB test can't,
 * because it would green-light a nonexistent column (the exact
 * "mocks that mislead" trap CLAUDE.md warns about).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import {
  buildLineItem,
  calculateDocumentTotals,
  LineItem,
} from '../../src/shared/billing-engine';
import { applyInvoiceEdits, InvoiceEditAction } from '../../src/invoices/invoice-editor';
import { applyEstimateEdits, EstimateEditAction } from '../../src/estimates/estimate-editor';

describe('Postgres integration — invoice_line_items.pricing_source (migration 255)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
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
      customerId,
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
      customerId,
      locationId,
      jobNumber: 'JOB-PS-001',
      summary: 'Pricing-source job',
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

  function lineWithSource(
    id: string,
    description: string,
    priceCents: number,
    sortOrder: number,
    pricingSource?: LineItem['pricingSource'],
  ): LineItem {
    const base = buildLineItem(id, description, 1, priceCents, sortOrder, true, 'material');
    return pricingSource ? { ...base, pricingSource } : base;
  }

  it('round-trips pricingSource on create() → findById()', async () => {
    const lineItems: LineItem[] = [
      lineWithSource(crypto.randomUUID(), 'Catalog part', 4_500, 0, 'catalog'),
      lineWithSource(crypto.randomUUID(), 'AI-priced widget', 12_345, 1, 'uncatalogued'),
      // No pricingSource set → must read back undefined (NOT grounded).
      lineWithSource(crypto.randomUUID(), 'Legacy manual line', 1_000, 2),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);

    const created = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-PS-1',
      status: 'draft',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const found = await invoiceRepo.findById(tenant.tenantId, created.id);
    expect(found).not.toBeNull();
    const byDesc = new Map(found!.lineItems.map((li) => [li.description, li]));
    expect(byDesc.get('Catalog part')!.pricingSource).toBe('catalog');
    expect(byDesc.get('AI-priced widget')!.pricingSource).toBe('uncatalogued');
    expect(byDesc.get('Legacy manual line')!.pricingSource).toBeUndefined();

    // Belt-and-braces: the value is really in the column, not just the map.
    const { rows } = await pool.query(
      `SELECT description, pricing_source FROM invoice_line_items
       WHERE invoice_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [created.id, tenant.tenantId],
    );
    expect(rows.map((r) => r.pricing_source)).toEqual(['catalog', 'uncatalogued', null]);
  });

  it('persists pricingSource through update() (DELETE + re-INSERT of line items)', async () => {
    const totals = calculateDocumentTotals(
      [buildLineItem('x', 'seed', 1, 1_000, 0, true, 'material')],
      0,
      0,
    );
    const created = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-PS-2',
      status: 'draft',
      lineItems: [lineWithSource(crypto.randomUUID(), 'seed', 1_000, 0, 'manual')],
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const nextLines = [
      lineWithSource(crypto.randomUUID(), 'Resolved catalog line', 8_000, 0, 'catalog'),
      lineWithSource(crypto.randomUUID(), 'Ambiguous line', 5_000, 1, 'ambiguous'),
    ];
    await invoiceRepo.update(tenant.tenantId, created.id, {
      lineItems: nextLines,
      totals: calculateDocumentTotals(nextLines, 0, 0),
      updatedAt: new Date(),
    });

    const found = await invoiceRepo.findById(tenant.tenantId, created.id);
    const byDesc = new Map(found!.lineItems.map((li) => [li.description, li]));
    expect(byDesc.get('Resolved catalog line')!.pricingSource).toBe('catalog');
    expect(byDesc.get('Ambiguous line')!.pricingSource).toBe('ambiguous');
    expect(byDesc.has('seed')).toBe(false);
  });

  it('carries pricingSource through an approved update_invoice edit (invoice-editor → repo → DB)', async () => {
    // Mirrors the real voice edit-execution path: UpdateInvoiceExecutionHandler
    // fetches the invoice, calls applyInvoiceEdits with the grounded
    // editActions payload (as ai/resolution/edit-action-grounding.ts stamps
    // it), then persists via invoiceRepo.update(). This pins the full
    // pipeline the invoice-editor previously dropped pricingSource from.
    const seedTotals = calculateDocumentTotals(
      [buildLineItem('seed', 'seed', 1, 1_000, 0, true, 'material')],
      0,
      0,
    );
    const created = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-PS-EDIT-1',
      status: 'draft',
      lineItems: [buildLineItem('seed', 'seed', 1, 1_000, 0, true, 'material')],
      totals: seedTotals,
      amountPaidCents: 0,
      amountDueCents: seedTotals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const editActions: InvoiceEditAction[] = [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Catalog-grounded repair line',
          quantity: 1,
          unitPrice: 6_500,
          category: 'material',
          pricingSource: 'catalog',
        },
      },
    ];
    const { updatedInvoice } = applyInvoiceEdits(created, editActions);
    await invoiceRepo.update(tenant.tenantId, created.id, {
      lineItems: updatedInvoice.lineItems,
      totals: updatedInvoice.totals,
      amountDueCents: updatedInvoice.amountDueCents,
      updatedAt: updatedInvoice.updatedAt,
    });

    const found = await invoiceRepo.findById(tenant.tenantId, created.id);
    const added = found!.lineItems.find((li) => li.description === 'Catalog-grounded repair line');
    expect(added?.pricingSource).toBe('catalog');

    const { rows } = await pool.query(
      `SELECT pricing_source FROM invoice_line_items
       WHERE invoice_id = $1 AND tenant_id = $2 AND description = $3`,
      [created.id, tenant.tenantId, 'Catalog-grounded repair line'],
    );
    expect(rows[0]?.pricing_source).toBe('catalog');
  });

  it('rejects an out-of-vocabulary pricing_source via the CHECK constraint', async () => {
    await expect(
      pool.query(
        `INSERT INTO invoice_line_items
           (id, tenant_id, invoice_id, description, category, quantity, unit_price_cents, total_cents, sort_order, taxable, pricing_source)
         SELECT $1, $2, id, 'bad', 'material', 1, 100, 100, 0, true, 'not_a_source'
         FROM invoices WHERE tenant_id = $2 LIMIT 1`,
        [crypto.randomUUID(), tenant.tenantId],
      ),
    ).rejects.toThrow();
  });
});

/**
 * Estimate mirror of the update_invoice edit-round-trip test above.
 * estimate_line_items.pricing_source has existed since migration 179 and
 * the repo write path was already correct — the gap fixed on this branch
 * was estimate-editor.ts dropping pricingSource before it ever reached the
 * repo. No prior integration test exercised the estimate edit → repo → DB
 * round trip for pricing_source, so this fills that gap alongside the
 * invoice case.
 */
describe('Postgres integration — estimate_line_items.pricing_source (edit round-trip)', () => {
  let pool: Pool;
  let estimateRepo: PgEstimateRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    estimateRepo = new PgEstimateRepository(pool);
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
      customerId,
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
      customerId,
      locationId,
      jobNumber: 'JOB-PS-EST-001',
      summary: 'Estimate pricing-source job',
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

  it('carries pricingSource through an approved update_estimate edit (estimate-editor → repo → DB)', async () => {
    const seedTotals = calculateDocumentTotals(
      [buildLineItem('seed', 'seed', 1, 1_000, 0, true, 'material')],
      0,
      0,
    );
    const created = await estimateRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      estimateNumber: 'EST-PS-EDIT-1',
      status: 'draft',
      lineItems: [buildLineItem('seed', 'seed', 1, 1_000, 0, true, 'material')],
      totals: seedTotals,
      createdBy: tenant.userId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const editActions: EstimateEditAction[] = [
      {
        type: 'add_line_item',
        lineItem: {
          description: 'Catalog-grounded fixture',
          quantity: 1,
          unitPrice: 9_900,
          category: 'material',
          pricingSource: 'catalog',
        },
      },
    ];
    const { updatedEstimate } = applyEstimateEdits(created, editActions);
    await estimateRepo.update(tenant.tenantId, created.id, {
      lineItems: updatedEstimate.lineItems,
      totals: updatedEstimate.totals,
      updatedAt: updatedEstimate.updatedAt,
    });

    const found = await estimateRepo.findById(tenant.tenantId, created.id);
    const added = found!.lineItems.find((li) => li.description === 'Catalog-grounded fixture');
    expect(added?.pricingSource).toBe('catalog');

    const { rows } = await pool.query(
      `SELECT pricing_source FROM estimate_line_items
       WHERE estimate_id = $1 AND tenant_id = $2 AND description = $3`,
      [created.id, tenant.tenantId, 'Catalog-grounded fixture'],
    );
    expect(rows[0]?.pricing_source).toBe('catalog');
  });
});
