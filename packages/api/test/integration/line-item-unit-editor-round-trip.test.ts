/**
 * B7.5 (PR review, FINDING A) — a descriptive `unit` must survive an operator
 * edit to an UNRELATED line.
 *
 * The defect this pins is silent data loss, not a display gap. Both
 * repositories replace ALL line-item rows on a lineItems update:
 *
 *   pg-invoice.ts   → DELETE FROM invoice_line_items WHERE invoice_id = $1
 *                     … then insertLineItems(payload)
 *   pg-estimate.ts  → DELETE FROM estimate_line_items WHERE estimate_id = $1
 *                     … then insertLineItems(payload)
 *
 * and `insertLineItems` writes `item.unit ?? null`. So any field the editor
 * round-trip drops is persisted as NULL on EVERY line — including lines the
 * operator never touched. The web editors (InvoicesPage / EstimatesPage
 * apiLineToUi + uiLineToApi) omitted `unit`, so a voice/catalog-grounded unit
 * disappeared the first time anyone edited a different row's price.
 *
 * This test drives the SERVER half of that path exactly as the route does:
 *   JSON body (as the browser sends it)
 *     → updateInvoiceSchema / updateEstimateSchema .parse()   (routes/*.ts)
 *     → updateInvoice / updateEstimate                         (domain)
 *     → repo.update()  → DELETE + re-INSERT
 *     → the RAW column
 *
 * Real Postgres, not a mocked Pool: a mocked DB would green-light a payload
 * whose column never received the value, which is the exact trap CLAUDE.md
 * calls out. The browser-side half (the editor conversions that build this
 * body) is pinned by the jsdom round-trip tests in packages/web —
 * InvoicesPage.unit-round-trip.test.tsx / EstimatesPage.unit-round-trip.test.tsx.
 *
 * Runs only under `npm run test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgEstimateRepository } from '../../src/estimates/pg-estimate';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals, LineItem } from '../../src/shared/billing-engine';
import { updateInvoice } from '../../src/invoices/invoice';
import { updateEstimate } from '../../src/estimates/estimate';
import { updateInvoiceSchema, updateEstimateSchema } from '../../src/shared/contracts';

/** A line carrying a descriptive unit, as the catalog resolver stamps it. */
function unitLine(
  id: string,
  description: string,
  quantity: number,
  priceCents: number,
  sortOrder: number,
  unit?: LineItem['unit'],
): LineItem {
  const base = buildLineItem(id, description, quantity, priceCents, sortOrder, true, 'material');
  return unit ? { ...base, unit } : base;
}

describe('Postgres integration — B7.5 unit survives an edit to an unrelated line', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let estimateRepo: PgEstimateRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let jobId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    estimateRepo = new PgEstimateRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Unit',
      lastName: 'Customer',
      displayName: 'Unit Customer',
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
      street1: '9 Unit Way',
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
      jobNumber: 'JOB-UNIT-RT-001',
      summary: 'Unit round-trip job',
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

  // ── Invoices ────────────────────────────────────────────────────────────

  async function seedInvoice(invoiceNumber: string): Promise<string> {
    const lineItems = [
      // The catalog-grounded, voice-authored line — the one nobody edits.
      unitLine(crypto.randomUUID(), 'R-410A refrigerant', 4, 3_200, 0, 'per lb'),
      // The line the operator actually edits.
      unitLine(crypto.randomUUID(), 'Diagnostic labor', 2, 9_500, 1, 'hour'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const created = await invoiceRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber,
      status: 'draft',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return created.id;
  }

  it('invoice: editing a DIFFERENT line leaves the untouched line’s unit in the raw column', async () => {
    const invoiceId = await seedInvoice('INV-UNIT-RT-1');

    // Precondition — the unit really is in the column before the edit.
    const before = await pool.query(
      `SELECT description, unit FROM invoice_line_items
       WHERE invoice_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [invoiceId, tenant.tenantId],
    );
    expect(before.rows.map((r) => r.unit)).toEqual(['per lb', 'hour']);

    // The browser reloads the invoice, maps it into the editor model, the
    // operator changes ONLY the labor line's rate, and the page PUTs the whole
    // lineItems array back. This is that request body — every line re-sent,
    // each one echoing the fields the editor model carries.
    const loaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    const body = {
      lineItems: loaded!.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        category: li.category ?? undefined,
        quantity: li.quantity,
        // Edit ONLY the labor line's price; the refrigerant line is untouched.
        unitPriceCents: li.description === 'Diagnostic labor' ? 11_000 : li.unitPriceCents,
        totalCents:
          li.description === 'Diagnostic labor' ? li.quantity * 11_000 : li.totalCents,
        sortOrder: li.sortOrder,
        taxable: li.taxable,
        ...(li.unit ? { unit: li.unit } : {}),
      })),
    };

    // Exactly what routes/invoices.ts does with req.body.
    const input = updateInvoiceSchema.parse(JSON.parse(JSON.stringify(body)));
    const result = await updateInvoice(tenant.tenantId, invoiceId, input, invoiceRepo);
    expect(result).not.toBeNull();

    // The RAW column, not the mapper: the DELETE + re-INSERT must have carried
    // the untouched line's unit back down.
    const after = await pool.query(
      `SELECT description, unit, unit_price_cents FROM invoice_line_items
       WHERE invoice_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [invoiceId, tenant.tenantId],
    );
    const byDesc = new Map(after.rows.map((r) => [r.description, r]));
    expect(byDesc.get('R-410A refrigerant')!.unit).toBe('per lb');
    expect(byDesc.get('Diagnostic labor')!.unit).toBe('hour');
    // The edit itself landed — otherwise the assertion above is trivially green
    // because nothing was written at all.
    expect(Number(byDesc.get('Diagnostic labor')!.unit_price_cents)).toBe(11_000);
    expect(Number(byDesc.get('R-410A refrigerant')!.unit_price_cents)).toBe(3_200);
  });

  it('invoice: a payload that OMITS unit NULLs it — the mechanism the editor fix exists to prevent', async () => {
    const invoiceId = await seedInvoice('INV-UNIT-RT-2');

    const loaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    // The pre-fix editor payload: same lines, same money, no `unit` key.
    const body = {
      lineItems: loaded!.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        category: li.category ?? undefined,
        quantity: li.quantity,
        unitPriceCents: li.unitPriceCents,
        totalCents: li.totalCents,
        sortOrder: li.sortOrder,
        taxable: li.taxable,
      })),
    };
    const input = updateInvoiceSchema.parse(JSON.parse(JSON.stringify(body)));
    await updateInvoice(tenant.tenantId, invoiceId, input, invoiceRepo);

    const after = await pool.query(
      `SELECT unit FROM invoice_line_items WHERE invoice_id = $1 AND tenant_id = $2`,
      [invoiceId, tenant.tenantId],
    );
    // Documented, deliberate: replace-all persistence means the payload is the
    // whole truth. Nothing server-side can recover a unit the client didn't
    // send, which is why the fix has to live in the editor conversions.
    expect(after.rows.map((r) => r.unit)).toEqual([null, null]);
  });

  it('invoice: money is untouched by the unit — totals match the same lines without one', async () => {
    const withUnits = [
      unitLine('a', 'R-410A refrigerant', 4, 3_200, 0, 'per lb'),
      unitLine('b', 'Diagnostic labor', 2, 9_500, 1, 'hour'),
    ];
    const withoutUnits = [
      unitLine('a', 'R-410A refrigerant', 4, 3_200, 0),
      unitLine('b', 'Diagnostic labor', 2, 9_500, 1),
    ];
    expect(calculateDocumentTotals(withUnits, 0, 0)).toEqual(
      calculateDocumentTotals(withoutUnits, 0, 0),
    );
  });

  // ── Estimates ───────────────────────────────────────────────────────────

  it('estimate: editing a DIFFERENT line leaves the untouched line’s unit in the raw column', async () => {
    const lineItems = [
      unitLine(crypto.randomUUID(), 'Deck staining', 240, 375, 0, 'sq ft'),
      unitLine(crypto.randomUUID(), 'Prep labor', 3, 8_500, 1, 'hour'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const created = await estimateRepo.create({
      id: crypto.randomUUID(),
      tenantId: tenant.tenantId,
      jobId,
      estimateNumber: 'EST-UNIT-RT-1',
      status: 'draft',
      lineItems,
      totals,
      createdBy: tenant.userId,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const before = await pool.query(
      `SELECT unit FROM estimate_line_items WHERE estimate_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [created.id, tenant.tenantId],
    );
    expect(before.rows.map((r) => r.unit)).toEqual(['sq ft', 'hour']);

    const loaded = await estimateRepo.findById(tenant.tenantId, created.id);
    const body = {
      lineItems: loaded!.lineItems.map((li) => ({
        id: li.id,
        description: li.description,
        quantity: li.quantity,
        // Only the prep-labor line changes.
        unitPriceCents: li.description === 'Prep labor' ? 9_000 : li.unitPriceCents,
        totalCents: li.description === 'Prep labor' ? li.quantity * 9_000 : li.totalCents,
        sortOrder: li.sortOrder,
        taxable: li.taxable,
        ...(li.unit ? { unit: li.unit } : {}),
      })),
    };

    // Exactly what routes/estimates.ts does with req.body.
    const input = updateEstimateSchema.parse(JSON.parse(JSON.stringify(body)));
    const result = await updateEstimate(tenant.tenantId, created.id, input, estimateRepo, {
      auditRepo,
      actorId: tenant.userId,
      actorRole: 'system',
    });
    expect(result).not.toBeNull();

    const after = await pool.query(
      `SELECT description, unit, unit_price_cents FROM estimate_line_items
       WHERE estimate_id = $1 AND tenant_id = $2 ORDER BY sort_order`,
      [created.id, tenant.tenantId],
    );
    const byDesc = new Map(after.rows.map((r) => [r.description, r]));
    expect(byDesc.get('Deck staining')!.unit).toBe('sq ft');
    expect(byDesc.get('Prep labor')!.unit).toBe('hour');
    expect(Number(byDesc.get('Prep labor')!.unit_price_cents)).toBe(9_000);
    expect(Number(byDesc.get('Deck staining')!.unit_price_cents)).toBe(375);
  });

  it('estimate: an unknown unit string is rejected at the contract boundary', async () => {
    // catalogUnitSchema is the validation boundary (the DB column is a plain
    // nullable TEXT with no CHECK), so a bogus unit must fail the route parse
    // rather than reaching the column.
    expect(() =>
      updateEstimateSchema.parse({
        lineItems: [
          {
            id: crypto.randomUUID(),
            description: 'Bad unit',
            quantity: 1,
            unit: 'furlong',
            unitPriceCents: 100,
            totalCents: 100,
            sortOrder: 0,
            taxable: true,
          },
        ],
      }),
    ).toThrow();
  });

  it('does not leak the unit-bearing rows to another tenant', async () => {
    const invoiceId = await seedInvoice('INV-UNIT-RT-3');
    const other = await createTestTenant(pool);
    expect(await invoiceRepo.findById(other.tenantId, invoiceId)).toBeNull();
  });
});
