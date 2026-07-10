/**
 * W1-2 — Hermetic proof: open invoice → signed Stripe webhook → paid.
 *
 * Continuous CI evidence for the money-settlement spine without Stripe
 * Elements/Checkout UI or live Stripe network. Mirrors the production
 * path in src/webhooks/routes.ts:
 *   checkout.session.completed (signed) → recordPayment → invoice.status=paid
 *
 * Idempotency: a second delivery of the same Stripe event id must not
 * double-apply (durable webhookRepo + payment count stays 1).
 *
 * Sibling: packages/api/test/integration/invoice-webhook-paid.test.ts
 * (Docker-gated, PgWebhookRepository + real Postgres).
 * UI companion: e2e/money-loop/invoice-webhook-paid.spec.ts
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';

import { createWebhookRouter, type WebhookRouterDeps } from '../../src/webhooks/routes';
import {
  createWebhookSignature,
  InMemoryWebhookRepository,
} from '../../src/webhooks/webhook-handler';
import { InMemoryInvoiceRepository, type Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_w1_2_invoice_paid';
const TENANT = '33333333-3333-3333-3333-333333333333';
const INVOICE_ID = 'inv-w1-2-001';
const AMOUNT_CENTS = 50_000;

function buildApp(deps: WebhookRouterDeps) {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return app;
}

async function postSigned(
  app: express.Express,
  body: Record<string, unknown>,
  secret = STRIPE_SECRET,
) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, secret))
    .set('content-type', 'application/json')
    .send(rawBody);
}

function makeOpenInvoice(): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service call', 1, AMOUNT_CENTS, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-w1-2-001',
    invoiceNumber: 'INV-W1-2-001',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function checkoutCompleted(eventId: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        amount_total: AMOUNT_CENTS,
        payment_status: 'paid',
        payment_intent: 'pi_w1_2_proof',
      },
    },
  };
}

describe('W1-2 — signed Stripe webhook → invoice paid', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let webhookRepo: InMemoryWebhookRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    webhookRepo = new InMemoryWebhookRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice());
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      webhookRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('rejects an unsigned webhook (no Elements / live Stripe required)', async () => {
    const rawBody = JSON.stringify(checkoutCompleted('evt_unsigned'));
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(400);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
  });

  it('rejects a webhook with an invalid signature', async () => {
    const rawBody = JSON.stringify(checkoutCompleted('evt_bad_sig'));
    const res = await request(app)
      .post('/webhooks/stripe')
      .set('stripe-signature', createWebhookSignature(rawBody, 'whsec_wrong_secret'))
      .set('content-type', 'application/json')
      .send(rawBody);
    expect(res.status).toBe(401);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
  });

  it('marks an open invoice paid on signed checkout.session.completed', async () => {
    const before = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(before?.status).toBe('open');
    expect(before?.amountDueCents).toBe(AMOUNT_CENTS);

    const res = await postSigned(app, checkoutCompleted('evt_w1_2_paid_1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(AMOUNT_CENTS);
    expect(inv?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].amountCents).toBe(AMOUNT_CENTS);
    expect(payments[0].providerReference).toBe('pi_w1_2_proof');
    expect(payments[0].method).toBe('credit_card');

    const recorded = auditRepo.getAll().find((e) => e.eventType === 'payment.recorded');
    expect(recorded).toBeDefined();
    expect(recorded!.actorId).toBe('stripe_webhook');
    expect(recorded!.entityId).toBe(INVOICE_ID);
  });

  it('is idempotent: replay of the same event id does not double-apply', async () => {
    const event = checkoutCompleted('evt_w1_2_idempotent');

    const first = await postSigned(app, event);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ received: true });

    const second = await postSigned(app, event);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true, duplicate: true });

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(AMOUNT_CENTS);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);

    const row = await webhookRepo.findByIdempotencyKey('stripe', 'evt_w1_2_idempotent');
    expect(row?.status).toBe('processed');
  });
});
