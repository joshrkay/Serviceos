/**
 * W1-2 — Docker-gated integration proof: signed Stripe webhook → paid.
 *
 * Pins the production path against real Postgres:
 *   PgInvoiceRepository + PgPaymentRepository + PgWebhookRepository
 *   + createWebhookRouter checkout.session.completed branch
 *
 * Proves durable idempotency (webhook_events unique on source+key) so a
 * replay cannot double-credit. No Stripe Elements / Checkout UI / live
 * Stripe network.
 *
 * Run via: cd packages/api && npm run test:integration -- invoice-webhook-paid
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

import { getSharedTestDb, createTestTenant, closeSharedTestDb } from './shared';
import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { PgWebhookRepository } from '../../src/webhooks/pg-webhook';
import { PgPaymentRepository } from '../../src/invoices/pg-payment';
import { PgInvoiceRepository } from '../../src/invoices/pg-invoice';
import { PgCustomerRepository } from '../../src/customers/pg-customer';
import { PgLocationRepository } from '../../src/locations/pg-location';
import { PgJobRepository } from '../../src/jobs/pg-job';
import { PgAuditRepository } from '../../src/audit/pg-audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_w1_2_integration';
const AMOUNT_CENTS = 50_000;

describe('Postgres integration — W1-2 invoice webhook → paid', () => {
  let pool: Pool;
  let app: express.Express;
  let paymentRepo: PgPaymentRepository;
  let invoiceRepo: PgInvoiceRepository;
  let webhookRepo: PgWebhookRepository;
  let tenant: { tenantId: string; userId: string };

  async function seedOpenInvoice(): Promise<string> {
    const customerRepo = new PgCustomerRepository(pool);
    const locationRepo = new PgLocationRepository(pool);
    const jobRepo = new PgJobRepository(pool);

    const customerId = randomUUID();
    await customerRepo.create({
      id: customerId,
      tenantId: tenant.tenantId,
      firstName: 'W1',
      lastName: 'Two',
      displayName: 'W1 Two',
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
      street1: '2 Money Loop Way',
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
      summary: 'W1-2 webhook paid proof',
      status: 'scheduled',
      priority: 'normal',
      createdBy: tenant.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const lineItems = [buildLineItem(randomUUID(), 'Service', 1, AMOUNT_CENTS, 1, false)];
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

  function checkoutEvent(eventId: string, invoiceId: string): Record<string, unknown> {
    return {
      id: eventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenant.tenantId, invoice_id: invoiceId },
          amount_total: AMOUNT_CENTS,
          payment_status: 'paid',
          payment_intent: `pi_${eventId}`,
        },
      },
    };
  }

  async function postSigned(body: Record<string, unknown>) {
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
    webhookRepo = new PgWebhookRepository(pool);
    const auditRepo = new PgAuditRepository(pool);
    tenant = await createTestTenant(pool);
    app = express();
    app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
    app.use(
      '/webhooks',
      createWebhookRouter({} as never, {
        invoiceRepo,
        paymentRepo,
        auditRepo,
        webhookRepo,
        stripeWebhookSecret: STRIPE_SECRET,
      }),
    );
  });

  afterAll(async () => {
    await closeSharedTestDb();
  });

  it('signed checkout.session.completed flips open invoice to paid (real columns)', async () => {
    const invoiceId = await seedOpenInvoice();
    const eventId = `evt_${randomUUID()}`;

    const before = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(before?.status).toBe('open');
    expect(before?.amountDueCents).toBe(AMOUNT_CENTS);

    const res = await postSigned(checkoutEvent(eventId, invoiceId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const after = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(after?.status).toBe('paid');
    expect(after?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(after?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
    expect(payments[0].providerReference).toBe(`pi_${eventId}`);

    const row = await webhookRepo.findByIdempotencyKey('stripe', eventId);
    expect(row?.status).toBe('processed');
  });

  it('replay of the same Stripe event id does not double-apply (durable idempotency)', async () => {
    const invoiceId = await seedOpenInvoice();
    const eventId = `evt_${randomUUID()}`;
    const event = checkoutEvent(eventId, invoiceId);

    const first = await postSigned(event);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const second = await postSigned(event);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const inv = await invoiceRepo.findById(tenant.tenantId, invoiceId);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(AMOUNT_CENTS);

    const payments = await paymentRepo.findByInvoice(tenant.tenantId, invoiceId);
    expect(payments).toHaveLength(1);

    const row = await webhookRepo.findByIdempotencyKey('stripe', eventId);
    expect(row?.status).toBe('processed');
  });
});
