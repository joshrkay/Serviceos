/**
 * Postgres integration — I9 / §8.8 row 8.13: the arithmetic invariant ACROSS
 * the DB boundary.
 *
 * `billing-engine.property.test.ts` fuzzes the pure engine in the unit lane:
 * 4000 seeded-PRNG documents, every money field an integer, no negative total.
 * What it cannot reach is I9's second clause — "`createInvoice` persists the
 * SERVER total, discarding the client's" — because nothing there is persisted.
 *
 * This file moves that clause across the boundary. It drives the production
 * `createInvoice` (src/invoices/invoice.ts:311) through `PgInvoiceRepository`
 * against real Postgres with line items whose client-supplied `totalCents` is
 * a LIE, then reads the persisted columns back with raw SQL — not the mapped
 * object, and never the in-memory repo. The engine itself is untouched: it is
 * called as the ORACLE the persisted rows are compared against.
 *
 * The randomized leg reuses the unit suite's mulberry32 so a failure is
 * reproducible from the printed seed + iteration.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { createInvoice } from '../../src/invoices/invoice';
import { calculateDocumentTotals } from '../../src/shared/billing-engine';
import type { LineItem } from '../../src/shared/billing-engine';

/** Same generator as test/shared/billing-engine.property.test.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a client POSTs: quantity + unit price, and a `totalCents` we ignore. */
interface ClientLine {
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  /** The client's claim about the line total — deliberately wrong. */
  claimedTotalCents: number;
}

function toLineItems(lines: ClientLine[]): LineItem[] {
  return lines.map((l, i) => ({
    id: crypto.randomUUID(),
    description: `item ${i}`,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    // The lie travels all the way into createInvoice, exactly as it would
    // from the REST body.
    totalCents: l.claimedTotalCents,
    sortOrder: i,
    taxable: l.taxable,
  }));
}

describe('Postgres integration — the SERVER total is what persists (I9 / row 8.13)', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };
  let jobId: string;
  let otherTenantJobId: string;

  async function seedJobChain(
    t: { tenantId: string; userId: string },
    label: string,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Arith',
      lastName: 'Metic',
      displayName: 'Arith Metic',
      preferredChannel: 'phone',
      smsConsent: false,
      isArchived: false,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const locationId = crypto.randomUUID();
    await locationRepo.create({
      id: locationId,
      tenantId: t.tenantId,
      customerId,
      street1: '7 Penny Ln',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      country: 'USA',
      isPrimary: true,
      addressType: 'service',
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const newJobId = crypto.randomUUID();
    await jobRepo.create({
      id: newJobId,
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Arithmetic job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return newJobId;
  }

  /** Persisted truth: the invoice money columns + its line totals. */
  async function persisted(tenantId: string, invoiceId: string) {
    const { rows } = await pool.query<{
      subtotal_cents: string;
      taxable_subtotal_cents: string;
      discount_cents: string;
      tax_cents: string;
      processing_fee_cents: string | null;
      total_cents: string;
      amount_due_cents: string;
      amount_paid_cents: string;
    }>(
      `SELECT subtotal_cents::text, taxable_subtotal_cents::text, discount_cents::text,
              tax_cents::text, processing_fee_cents::text, total_cents::text,
              amount_due_cents::text, amount_paid_cents::text
         FROM invoices WHERE tenant_id = $1 AND id = $2`,
      [tenantId, invoiceId],
    );
    const lines = await pool.query<{ total_cents: string; quantity: string; unit_price_cents: string }>(
      `SELECT total_cents::text, quantity::text, unit_price_cents::text
         FROM invoice_line_items WHERE tenant_id = $1 AND invoice_id = $2
         ORDER BY sort_order`,
      [tenantId, invoiceId],
    );
    return { invoice: rows[0], lines: lines.rows };
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);
    jobId = await seedJobChain(tenant, 'ARITH-1');
    otherTenantJobId = await seedJobChain(otherTenant, 'ARITH-NEIGHBOUR');
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it("the client's line total is discarded: the fractional-quantity cent lands server-side", async () => {
    // The exact P0-2 divergence: the web UI round-trips through float dollars
    // and computes 14 for 0.5 × 29¢; the server formula gives 15. Whatever the
    // client claims, the persisted number is the server's.
    const lines: ClientLine[] = [
      { quantity: 0.5, unitPriceCents: 29, taxable: true, claimedTotalCents: 14 },
      { quantity: 3, unitPriceCents: 1999, taxable: true, claimedTotalCents: 1 },
    ];
    const created = await createInvoice(
      {
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: `INV-ARITH-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: toLineItems(lines),
        discountCents: 0,
        taxRateBps: 825,
        createdBy: tenant.userId,
      },
      invoiceRepo,
      auditRepo,
    );

    const { invoice, lines: persistedLines } = await persisted(tenant.tenantId, created.id);
    expect(persistedLines.map((l) => Number(l.total_cents))).toEqual([15, 5997]);
    expect(Number(invoice.subtotal_cents)).toBe(6012);
    // 8.25% of 6012 = 496.0 → 496 (applyBps rounds to the nearest cent).
    expect(Number(invoice.tax_cents)).toBe(496);
    expect(Number(invoice.total_cents)).toBe(6508);
    expect(Number(invoice.amount_due_cents)).toBe(6508);
    // The client's 14 + 1 = 15 never reached a column.
    expect(Number(invoice.subtotal_cents)).not.toBe(15);

    // And the creation is on the audit trail under this tenant.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', created.id);
    expect(events.map((e) => e.eventType)).toContain('invoice.created');
  });

  it('1000 randomized documents: every persisted money column is an integer, non-negative, and the engine\'s own number', async () => {
    const SEED = 0x5c0ffee;
    const ITERATIONS = 1000;
    const rand = mulberry32(SEED);

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const n = 1 + Math.floor(rand() * 6); // 1..6 lines (createInvoice needs ≥1)
      const lines: ClientLine[] = [];
      for (let i = 0; i < n; i++) {
        // Fractional quantities are where float round-tripping diverges.
        const quantity = Math.round(rand() * 800) / 100; // 0.00 … 8.00
        const unitPriceCents = Math.floor(rand() * 50000);
        lines.push({
          quantity: quantity === 0 ? 1 : quantity,
          unitPriceCents,
          taxable: rand() < 0.5,
          // A lie of a different shape each time: negative, float, absurd.
          claimedTotalCents: [-1, 0.5, 999999999, 7][iter % 4],
        });
      }
      const discountCents = Math.floor(rand() * 20000);
      const taxRateBps = Math.floor(rand() * 1500);
      const processingFeeBps = Math.floor(rand() * 400);

      const lineItems = toLineItems(lines);
      const created = await createInvoice(
        {
          tenantId: tenant.tenantId,
          jobId,
          invoiceNumber: `INV-FUZZ-${iter}-${crypto.randomUUID().slice(0, 8)}`,
          lineItems,
          discountCents,
          taxRateBps,
          processingFeeBps,
          createdBy: tenant.userId,
        },
        invoiceRepo,
      );

      // The oracle: the engine over SERVER-computed line totals.
      const expectedLines = lines.map((l) => Math.round(l.quantity * l.unitPriceCents));
      const oracle = calculateDocumentTotals(
        lineItems.map((li, i) => ({ ...li, totalCents: expectedLines[i] })),
        discountCents,
        taxRateBps,
        processingFeeBps,
      );

      const { invoice, lines: persistedLines } = await persisted(tenant.tenantId, created.id);
      const ctx = `seed=0x${SEED.toString(16)} iter=${iter}`;

      // Line totals are the server's, never the client's claim.
      expect(persistedLines.map((l) => Number(l.total_cents)), ctx).toEqual(expectedLines);

      const money = {
        subtotal: Number(invoice.subtotal_cents),
        taxableSubtotal: Number(invoice.taxable_subtotal_cents),
        discount: Number(invoice.discount_cents),
        tax: Number(invoice.tax_cents),
        fee: Number(invoice.processing_fee_cents ?? 0),
        total: Number(invoice.total_cents),
        due: Number(invoice.amount_due_cents),
        paid: Number(invoice.amount_paid_cents),
      };

      // Every persisted money column survives the round trip as an INTEGER —
      // a float leaking into a numeric column would show up here, after the
      // driver, not before it.
      for (const [name, value] of Object.entries(money)) {
        expect(Number.isInteger(value), `${ctx} ${name}=${value}`).toBe(true);
      }
      // …and the total never goes negative, however pathological the discount.
      expect(money.total, ctx).toBeGreaterThanOrEqual(0);
      expect(money.due, ctx).toBeGreaterThanOrEqual(0);

      // …and it is the ENGINE's number, persisted, not a re-derivation.
      expect(money.subtotal, ctx).toBe(oracle.subtotalCents);
      expect(money.taxableSubtotal, ctx).toBe(oracle.taxableSubtotalCents);
      expect(money.tax, ctx).toBe(oracle.taxCents);
      expect(money.fee, ctx).toBe(oracle.processingFeeCents ?? 0);
      expect(money.total, ctx).toBe(oracle.totalCents);
      expect(money.due, ctx).toBe(oracle.totalCents);
      expect(money.paid, ctx).toBe(0);
    }
  });

  it("a neighbour tenant's identical payload persists its own totals, invisible to this tenant", async () => {
    const lines: ClientLine[] = [
      { quantity: 2, unitPriceCents: 12345, taxable: true, claimedTotalCents: 1 },
    ];
    const mine = await createInvoice(
      {
        tenantId: tenant.tenantId,
        jobId,
        invoiceNumber: `INV-ARITH-MINE-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: toLineItems(lines),
        discountCents: 500,
        taxRateBps: 1000,
        createdBy: tenant.userId,
      },
      invoiceRepo,
      auditRepo,
    );
    const theirs = await createInvoice(
      {
        tenantId: otherTenant.tenantId,
        jobId: otherTenantJobId,
        invoiceNumber: `INV-ARITH-THEIRS-${crypto.randomUUID().slice(0, 8)}`,
        lineItems: toLineItems(lines),
        discountCents: 500,
        taxRateBps: 1000,
        createdBy: otherTenant.userId,
      },
      invoiceRepo,
      auditRepo,
    );

    // Same arithmetic, two separate rows — and each is readable only under
    // its own tenant.
    const mineRow = await persisted(tenant.tenantId, mine.id);
    const theirRow = await persisted(otherTenant.tenantId, theirs.id);
    expect(Number(mineRow.invoice.total_cents)).toBe(26609);
    expect(Number(theirRow.invoice.total_cents)).toBe(26609);
    expect(await invoiceRepo.findById(otherTenant.tenantId, mine.id)).toBeNull();
    expect(await invoiceRepo.findById(tenant.tenantId, theirs.id)).toBeNull();
    expect(await auditRepo.findByEntity(tenant.tenantId, 'invoice', theirs.id)).toEqual([]);
    expect(
      (await auditRepo.findByEntity(otherTenant.tenantId, 'invoice', theirs.id)).map(
        (e) => e.eventType,
      ),
    ).toContain('invoice.created');
  });
});
