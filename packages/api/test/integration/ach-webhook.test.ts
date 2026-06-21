/**
 * U5 — ACH async-lifecycle integration test (Docker-gated).
 *
 * NOT run in web sessions — requires the testcontainer Postgres started by
 * `npm run test:integration` (vitest globalSetup). Pins the in-flight
 * 'processing' state against REAL Postgres: the status CHECK must accept
 * 'processing' (migration 026 / re-asserted in 179), the in-flight credit
 * and settlement must persist with tenant RLS, and the full webhook
 * sequence must leave exactly one net credit + a complete audit chain.
 *
 * Drives the real Stripe webhook router (src/webhooks/routes.ts) against
 * the pg repos so we exercise the same code production runs — not a mock.
 * Pattern mirrors test/integration/payments.test.ts + the route-level
 * test/webhooks/stripe-payment-events.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_ach_integration';

describe('Postgres integration — ACH webhook lifecycle (U5)', () => {
  let pool: Pool;
  let app: express.Express;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let auditRepo: PgAuditRepository;
  let tenant: { tenantId: string; userId: string };

  // Each test gets its own invoice so they don't interfere.
  async function makeInvoice(totalCents = 10000): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'ACH',
      lastName: 'Customer',
      displayName: 'ACH Customer',
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
      street1: '1 ACH Way',
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
      summary: 'ACH test job',
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

  function event(type: string, piId: string, invoiceId: string, amount: number) {
    return {
      id: `evt_${randomUUID()}`,
      type,
      data: {
        object: {
          id: piId,
          amount,
          amount_received: type === 'payment_intent.succeeded' ? amount : 0,
          metadata: { tenant_id: tenant.tenantId, invoice_id: invoiceId },
          charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
          last_payment_error:
            type === 'payment_intent.payment_failed'
              ? { code: 'debit_not_authorized', decline_code: 'debit_not_authorized' }
              : undefined,
        },
      },
    };
  }

  async function post(body: Record<string, unknown>) {
    const raw = JSON.stringify(body);
    return request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(raw, STRIPE_SECRET))
      .set('content-type', 'application/json')
      .send(raw);
  }

  beforeAll(async () => {
    pool = await getSharedTestDb();
    paymentRepo = new PgPaymentRepository(pool);
    invoiceRepo = new PgInvoiceRepository(pool);
    auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('processing → succeeded persists one completed payment + paid invoice + audit chain', async () => {
    const invoiceId = await makeInvoice(10000);
    const piId = `pi_${randomUUID()}`;

    // processing → in-flight 'processing' row persisted, invoice credited.
    const r1 = await post(event('payment_intent.processing', piId, invoiceId, 10000));
    expect(r1.status).toBe(200);

    let payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');
    expect(payments[0].method).toBe('bank_transfer');
    expect(payments[0].amountCents).toBe(10000);

    let inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.amountPaidCents).toBe(10000);
    expect(inv?.status).toBe('paid');

    // succeeded → flip to 'completed', NO second credit.
    const r2 = await post(event('payment_intent.succeeded', piId, invoiceId, 10000));
    expect(r2.status).toBe(200);

    payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');

    inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.amountPaidCents).toBe(10000); // exactly once
    expect(inv?.status).toBe('paid');

    // Audit chain correlated by the payment_intent id.
    const audits = await auditRepo.findByCorrelation(tenant.tenantId, piId);
    const types = audits.map((a) => a.eventType);
    expect(types).toContain('payment.processing');
    expect(types).toContain('payment.recorded');
  });

  it('processing → payment_failed reverses the in-flight credit and reopens the invoice', async () => {
    const invoiceId = await makeInvoice(10000);
    const piId = `pi_${randomUUID()}`;

    await post(event('payment_intent.processing', piId, invoiceId, 10000));
    expect((await invoiceRepo.findById(tenant.tenantId, invoiceId))?.status).toBe('paid');

    const res = await post(event('payment_intent.payment_failed', piId, invoiceId, 10000));
    expect(res.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('ach_return');
    expect(payments[0].reversedAt).not.toBeNull();

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(10000);

    const audits = await auditRepo.findByCorrelation(tenant.tenantId, piId);
    expect(audits.map((a) => a.eventType)).toContain('payment.reversed');
  });

  it('duplicate processing delivery does not double-credit', async () => {
    const invoiceId = await makeInvoice(10000);
    const piId = `pi_${randomUUID()}`;

    await post(event('payment_intent.processing', piId, invoiceId, 10000));
    const dup = await post(event('payment_intent.processing', piId, invoiceId, 10000));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.amountPaidCents).toBe(10000);
  });

  it('a processing payment row is rejected by neither the status CHECK nor RLS (cross-tenant isolated)', async () => {
    const invoiceId = await makeInvoice(10000);
    const piId = `pi_${randomUUID()}`;
    await post(event('payment_intent.processing', piId, invoiceId, 10000));

    // The 'processing' row exists for our tenant...
    const mine = await paymentRepo.findByProviderReference(tenant.tenantId, piId);
    expect(mine?.status).toBe('processing');

    // ...but is invisible to another tenant (RLS).
    const other = await createTestTenant(pool);
    const leaked = await paymentRepo.findByProviderReference(other.tenantId, piId);
    expect(leaked).toBeNull();
  });
});
