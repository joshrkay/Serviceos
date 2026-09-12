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
 * #1022 row 8.6: the dedup is also an AUDIT claim — a replayed intent must
 * leave exactly ONE `payment.recorded` event, read back through the real
 * PgAuditRepository, or the timeline shows money that was never taken. And the
 * unique index is per-tenant: a NEIGHBOUR tenant carrying the SAME provider
 * reference credits its own invoice and never this one.
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
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

describe('Postgres integration — duplicate Stripe payment is rejected + handled', () => {
  let pool: Pool;
  let invoiceRepo: PgInvoiceRepository;
  let paymentRepo: PgPaymentRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };
  let otherTenant: { tenantId: string; userId: string };
  let invoiceId: string;
  let otherTenantInvoiceId: string;

  /**
   * Seed one tenant's fixture chain (customer → location → job → open invoice).
   * Shared by the tenant under test and the neighbour tenant so the two differ
   * only by tenant_id.
   */
  async function seedOpenInvoice(
    t: { tenantId: string; userId: string },
    label: string,
    totalCents: number,
  ): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = crypto.randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: t.tenantId,
      firstName: 'Dup',
      lastName: 'Pay',
      displayName: 'Dup Pay',
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
      tenantId: t.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${label}`,
      summary: 'Dup pay job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const newInvoiceId = crypto.randomUUID();
    const lineItems = [
      buildLineItem(crypto.randomUUID(), 'Service', 1, totalCents, 0, true, 'labor'),
    ];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    await invoiceRepo.create({
      id: newInvoiceId,
      tenantId: t.tenantId,
      jobId,
      invoiceNumber: `INV-${label}`,
      status: 'open',
      lineItems,
      totals,
      amountPaidCents: 0,
      amountDueCents: totals.totalCents,
      createdBy: t.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return newInvoiceId;
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    invoiceRepo = new PgInvoiceRepository(pool);
    paymentRepo = new PgPaymentRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    otherTenant = await createTestTenant(pool);

    invoiceId = await seedOpenInvoice(tenant, 'DUP-1', 20000);
    otherTenantInvoiceId = await seedOpenInvoice(otherTenant, 'DUP-NEIGHBOUR', 20000);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('a second recordPayment for the same intent credits the invoice only once', async () => {
    const ref = 'pi_dup_race_1';
    const ctx = { tenantId: tenant.tenantId, invoiceId, amountCents: 10000, method: 'credit_card' as const, providerReference: ref, processedBy: 'stripe_webhook' };

    const first = await recordPayment(ctx, invoiceRepo, paymentRepo, undefined, undefined, auditRepo);
    const second = await recordPayment(ctx, invoiceRepo, paymentRepo, undefined, undefined, auditRepo);

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

    // The audit trail says the same thing the ledger does: ONE credit. The
    // duplicate delivery finds the invoice already consistent with the ledger
    // (`repaired: false`) and must therefore emit no second `payment.recorded`
    // — a second event would put money on the timeline that was never taken.
    const events = await auditRepo.findByEntity(tenant.tenantId, 'invoice', invoiceId);
    const recorded = events.filter((e) => e.eventType === 'payment.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].metadata!.amountCents).toBe(10000);
    expect(recorded[0].metadata!.providerReference).toBe(ref);
    expect(recorded[0].metadata!.paymentId).toBe(first.payment.id);
    expect(recorded[0].tenantId).toBe(tenant.tenantId);
  });

  it('a failed attempt does not block the later successful retry of the same intent', async () => {
    // recordFailedPaymentAttempt stamps the PI id as reference on a
    // status='failed' credit_card row. The index is scoped to crediting
    // statuses, so a subsequent success for that intent must still insert +
    // credit (not be swallowed as an idempotent duplicate).
    const ref = 'pi_failed_then_ok';
    await pool.query(
      `INSERT INTO payments (id, tenant_id, invoice_id, amount_cents, status, payment_method, reference_number, created_by)
       VALUES ($1,$2,$3,$4,'failed','credit_card',$5,'test')`,
      [crypto.randomUUID(), tenant.tenantId, invoiceId, 10000, ref],
    );

    const before = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    const paidBefore = before!.amountPaidCents;

    const res = await recordPayment(
      { tenantId: tenant.tenantId, invoiceId, amountCents: 10000, method: 'credit_card', providerReference: ref, processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );

    // The success recorded a NEW completed row (not the failed one).
    expect(res.payment.status).toBe('completed');
    const after = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(after!.amountPaidCents).toBe(paidBefore + 10000); // invoice credited
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

  it('the SAME provider reference in a neighbour tenant credits only that tenant', async () => {
    // idx_payments_stripe_reference_unique is keyed (tenant_id,
    // reference_number): two tenants can legitimately hold the same Stripe
    // reference (distinct Connect accounts), and neither the insert dedup nor
    // the credit may cross the tenant line.
    const sharedRef = 'pi_dup_race_1'; // already recorded against THIS tenant
    const mineBefore = await invoiceRepo.findById(tenant.tenantId, invoiceId);

    const neighbour = await recordPayment(
      {
        tenantId: otherTenant.tenantId,
        invoiceId: otherTenantInvoiceId,
        amountCents: 7000,
        method: 'credit_card',
        providerReference: sharedRef,
        processedBy: 'stripe_webhook',
      },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
    );

    // The neighbour's insert was NOT swallowed as a duplicate of this tenant's
    // row, and it credited the neighbour's own invoice.
    expect(neighbour.payment.tenantId).toBe(otherTenant.tenantId);
    const theirs = await invoiceRepo.findById(otherTenant.tenantId, otherTenantInvoiceId);
    expect(theirs!.amountPaidCents).toBe(7000);
    expect(theirs!.amountDueCents).toBe(13000);

    // This tenant's balance did not move, and its ledger still holds exactly
    // one row for that reference.
    const mineAfter = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(mineAfter!.amountPaidCents).toBe(mineBefore!.amountPaidCents);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND reference_number = $2`,
      [tenant.tenantId, sharedRef],
    );
    expect(rows[0].n).toBe(1);

    // …and the neighbour's credit is on the NEIGHBOUR's audit trail only.
    const theirEvents = await auditRepo.findByEntity(
      otherTenant.tenantId,
      'invoice',
      otherTenantInvoiceId,
    );
    expect(theirEvents.filter((e) => e.eventType === 'payment.recorded')).toHaveLength(1);
    expect(
      await auditRepo.findByEntity(tenant.tenantId, 'invoice', otherTenantInvoiceId),
    ).toEqual([]);
  });
});
