/**
 * Docker-gated integration tests — NOT run in web sessions. Requires the
 * testcontainer Postgres started by `npm run test:integration`.
 *
 * E2a (one-time ACH "processing") — proves the U1 domain foundation
 * against REAL Postgres columns + RLS (the unit suite mocks the repo, so
 * per CLAUDE.md the real-column behavior is pinned here):
 *   - migration 178's partial unique index rejects a 2nd payment row for
 *     the same (tenant_id, reference_number).
 *   - recordProcessingPayment + settleProcessingPayment: row
 *     processing→completed, invoice open→paid, balances correct.
 *   - recordProcessingPayment + failProcessingPayment: row
 *     processing→failed, invoice UNTOUCHED (stays open).
 *   - transitionFromProcessing CAS returns null once the row has left
 *     `processing` (idempotent no-op).
 *
 * NOTE: this file will NOT run locally (no Docker image available in the
 * sandbox) — it is written for PR CI.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { getSharedTestDb, createTestTenant, closeSharedTestDb, TestTenant } from './shared';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';
import { recordProcessingPayment, Payment } from '../../src/invoices/payment';
import {
  settleProcessingPayment,
  failProcessingPayment,
} from '../../src/payments/payment-service';

describe('Postgres integration — ACH processing lifecycle (E2a U1)', () => {
  let pool: Pool;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let jobRepo: PgJobRepository;
  let customerRepo: PgCustomerRepository;
  let locationRepo: PgLocationRepository;
  let tenant: TestTenant;

  beforeAll(async () => {
    pool = await getSharedTestDb();
    paymentRepo = new PgPaymentRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    jobRepo = new PgJobRepository(pool);
    customerRepo = new PgCustomerRepository(pool);
    locationRepo = new PgLocationRepository(pool);
    tenant = await createTestTenant(pool);
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  /** Build the customer → location → job → open-invoice FK chain. */
  async function createOpenInvoice(totalCents = 50000): Promise<string> {
    const customerId = randomUUID();
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

    const locationId = randomUUID();
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

    const jobId = randomUUID();
    await jobRepo.create({
      id: jobId,
      tenantId: tenant.tenantId,
      customerId,
      locationId,
      jobNumber: `JOB-${jobId.slice(0, 8)}`,
      summary: 'Test job',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service', 1, totalCents, 1, false)];
    const totals = calculateDocumentTotals(lineItems, 0, 0);
    const invoiceId = randomUUID();
    await invoiceRepo.create({
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
    return invoiceId;
  }

  function makePaymentRow(invoiceId: string, ref: string, over: Partial<Payment> = {}): Payment {
    const now = new Date();
    return {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      invoiceId,
      amountCents: 50000,
      method: 'bank_transfer',
      status: 'processing',
      providerReference: ref,
      receivedAt: now,
      processedBy: tenant.userId,
      createdAt: now,
      updatedAt: now,
      refundedAmountCents: 0,
      refundedAt: null,
      lastRefundStripeId: null,
      reversedAt: null,
      reversalReason: null,
      ...over,
    };
  }

  it('migration 178 partial-unique index rejects a 2nd row for the same (tenant, reference_number)', async () => {
    const invoiceId = await createOpenInvoice();
    const ref = `pi_unique_${randomUUID()}`;

    // First insert succeeds.
    const first = await paymentRepo.createIfNotExists(makePaymentRow(invoiceId, ref));
    expect(first).not.toBeNull();

    // Second insert for the SAME (tenant, reference_number) conflicts →
    // ON CONFLICT DO NOTHING → 0 rows → null (no duplicate created).
    const second = await paymentRepo.createIfNotExists(makePaymentRow(invoiceId, ref));
    expect(second).toBeNull();

    // Exactly one row persisted for that reference.
    const rows = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(rows.filter((r) => r.providerReference === ref)).toHaveLength(1);
  });

  it('a raw INSERT of a duplicate (tenant, reference_number) is rejected by the unique index', async () => {
    const invoiceId = await createOpenInvoice();
    const ref = `pi_raw_${randomUUID()}`;
    await paymentRepo.createIfNotExists(makePaymentRow(invoiceId, ref));

    // Bypass ON CONFLICT — a plain INSERT must violate the unique index.
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL app.current_tenant_id = '${tenant.tenantId}'`);
      await expect(
        client.query(
          `INSERT INTO payments (
             id, tenant_id, invoice_id, amount_cents, status,
             payment_method, reference_number, paid_at, created_by,
             created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8,now(),now())`,
          [randomUUID(), tenant.tenantId, invoiceId, 50000, 'processing', 'bank_transfer', ref, tenant.userId],
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('NULL reference_number rows are NOT constrained (manual cash/check)', async () => {
    const invoiceId = await createOpenInvoice();
    // Two completed rows with no reference_number must both persist.
    const a = await paymentRepo.create(
      makePaymentRow(invoiceId, '', { status: 'completed', providerReference: undefined }),
    );
    const b = await paymentRepo.create(
      makePaymentRow(invoiceId, '', { status: 'completed', providerReference: undefined }),
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const rows = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(rows.filter((r) => r.providerReference === undefined).length).toBeGreaterThanOrEqual(2);
  });

  it('processing → settle: row completed, invoice open → paid (real columns)', async () => {
    const invoiceId = await createOpenInvoice(50000);
    const ref = `pi_settle_${randomUUID()}`;

    const { created } = await recordProcessingPayment(
      {
        tenantId: tenant.tenantId,
        invoiceId,
        amountCents: 50000,
        method: 'bank_transfer',
        providerReference: ref,
        processedBy: tenant.userId,
      },
      paymentRepo,
    );
    expect(created).toBe(true);
    // Invoice still open during the processing window.
    expect((await invoiceRepo.findById(tenant.tenantId, invoiceId))?.status).toBe('open');

    const result = await settleProcessingPayment(
      { tenantId: tenant.tenantId, providerReference: ref, settledAmountCents: 50000 },
      invoiceRepo,
      paymentRepo,
    );
    expect(result.settled).toBe(true);

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(50000);
    expect(inv?.amountDueCents).toBe(0);

    const row = (await paymentRepo.findByInvoice(tenant.tenantId, invoiceId)).find(
      (r) => r.providerReference === ref,
    );
    expect(row?.status).toBe('completed');
    expect(row?.amountCents).toBe(50000);

    // Double-settle is a no-op (CAS lost): invoice not double-credited.
    const again = await settleProcessingPayment(
      { tenantId: tenant.tenantId, providerReference: ref, settledAmountCents: 50000 },
      invoiceRepo,
      paymentRepo,
    );
    expect(again.settled).toBe(false);
    expect((await invoiceRepo.findById(tenant.tenantId, invoiceId))?.amountPaidCents).toBe(50000);
  });

  it('processing → fail: row failed, invoice UNTOUCHED (stays open)', async () => {
    const invoiceId = await createOpenInvoice(50000);
    const ref = `pi_fail_${randomUUID()}`;

    await recordProcessingPayment(
      {
        tenantId: tenant.tenantId,
        invoiceId,
        amountCents: 50000,
        method: 'bank_transfer',
        providerReference: ref,
        processedBy: tenant.userId,
      },
      paymentRepo,
    );

    const result = await failProcessingPayment(
      { tenantId: tenant.tenantId, providerReference: ref, reason: 'ach_failed' },
      paymentRepo,
    );
    expect(result.failed).toBe(true);

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(50000);

    const row = (await paymentRepo.findByInvoice(tenant.tenantId, invoiceId)).find(
      (r) => r.providerReference === ref,
    );
    expect(row?.status).toBe('failed');
    expect(row?.reversalReason).toBe('ach_failed');
  });

  it('transitionFromProcessing CAS returns null once the row has left processing', async () => {
    const invoiceId = await createOpenInvoice();
    const ref = `pi_cas_${randomUUID()}`;
    const inserted = await paymentRepo.createIfNotExists(makePaymentRow(invoiceId, ref));
    expect(inserted).not.toBeNull();

    // First CAS wins.
    const won = await paymentRepo.transitionFromProcessing(
      tenant.tenantId,
      inserted!.id,
      'completed',
      { amountCents: 50000, receivedAt: new Date() },
    );
    expect(won?.status).toBe('completed');

    // Second CAS sees a non-processing status → null (idempotent no-op).
    const lost = await paymentRepo.transitionFromProcessing(
      tenant.tenantId,
      inserted!.id,
      'failed',
      { reversalReason: 'ach_failed' },
    );
    expect(lost).toBeNull();

    // Cross-tenant CAS also returns null.
    const other = await createTestTenant(pool);
    const crossTenant = await paymentRepo.transitionFromProcessing(
      other.tenantId,
      inserted!.id,
      'failed',
    );
    expect(crossTenant).toBeNull();
  });
});
