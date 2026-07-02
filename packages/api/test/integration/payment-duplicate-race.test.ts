/**
 * Duplicate-payment race backstop against real Postgres (migration 229).
 *
 * Two Stripe events for the same intent (checkout.session.completed +
 * payment_intent.succeeded), or a webhook retry with a distinct event id, can
 * both clear recordPayment's check-then-insert dedup before either commits and
 * insert two 'completed' rows — double-counting revenue. The partial unique
 * index (tenant_id, reference_number) WHERE payment_method IN
 * ('credit_card','bank_transfer') rejects the second insert with 23505, and
 * recordPayment returns the existing row without crediting the invoice twice.
 *
 * InMemoryPaymentRepository can't reproduce the constraint (the mocked-DB trap
 * CLAUDE.md warns about), so this exercises the REAL repo + index.
 *
 * Runs only under `npm run test:integration` (vitest globalSetup starts the
 * Postgres testcontainer and sets TEST_DB_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { recordPayment } from '../../src/invoices/payment';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — duplicate Stripe payment is rejected + handled', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let tenant: { tenantId: string; userId: string };
  let invoiceId: string;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);
    tenant = await createTestTenant(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'Dup',
      lastName: 'Pay',
      displayName: 'Dup Pay',
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
      street1: '1 Pay St',
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
    const jobId = crypto.randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: 'JOB-DUP-1',
      summary: 'Dup pay job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    invoiceId = crypto.randomUUID();
    const lineItems = [buildLineItem(crypto.randomUUID(), 'Service', 1, 20000, 0, true, 'labor')];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: invoiceId,
      tenantId: tenant.tenantId,
      jobId,
      invoiceNumber: 'INV-DUP-1',
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

  it('a second recordPayment for the same intent credits the invoice only once', async () => {
    const ref = 'pi_dup_race_1';
    const ctx = { tenantId: tenant.tenantId, invoiceId, amountCents: 10000, method: 'credit_card' as const, providerReference: ref, processedBy: 'stripe_webhook' };

    const first = await recordPayment(ctx, invoiceRepo, paymentRepo);
    const second = await recordPayment(ctx, invoiceRepo, paymentRepo);

    // Idempotent: the second event returns the row the first recorded.
    expect(second.payment.id).toBe(first.payment.id);

    // Exactly one payment row for this reference.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND reference_number = $2`,
      [tenant.tenantId, ref],
    );
    expect(rows[0].n).toBe(1);

    // Invoice credited once, not twice.
    const reloaded = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(reloaded!.amountPaidCents).toBe(10000);
    expect(reloaded!.amountDueCents).toBe(10000);
  });

  it('the raw duplicate INSERT is rejected by the partial unique index (23505)', async () => {
    // Direct insert of a second credit_card row with the same reference must
    // violate idx_payments_stripe_reference_unique.
    const ref = 'pi_dup_race_2';
    const insert = (id: string) =>
      pool.query(
        `INSERT INTO payments (id, tenant_id, invoice_id, amount_cents, status, payment_method, reference_number, created_by)
         VALUES ($1,$2,$3,$4,'completed','credit_card',$5,'test')`,
        [id, tenant.tenantId, invoiceId, 5000, ref],
      );
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toMatchObject({ code: '23505' });
  });
});
