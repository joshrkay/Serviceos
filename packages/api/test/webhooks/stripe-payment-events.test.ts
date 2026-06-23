/**
 * Route-level tests for the invoice-to-cash failure/async-settlement
 * branches added to src/webhooks/routes.ts:
 *   - payment_intent.succeeded   — async (ACH/bank) settlement marks paid,
 *                                  idempotent vs. an already-recorded card
 *   - payment_intent.payment_failed — plain decline records a failed
 *                                  attempt; a post-settlement failure
 *                                  (NSF/ACH return) reverses + reopens
 *   - charge.dispute.created     — chargeback reverses + reopens
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_payevents';
const TENANT = '22222222-2222-2222-2222-222222222222';
const INVOICE_ID = 'inv-pe-001';

function buildApp(deps: Parameters<typeof createWebhookRouter>[1]) {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use('/webhooks', createWebhookRouter({} as never, deps));
  return app;
}

async function postSigned(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', createWebhookSignature(rawBody, STRIPE_SECRET))
    .set('content-type', 'application/json')
    .send(rawBody);
}

function makeOpenInvoice(totalCents = 10000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-pe-001',
    invoiceNumber: 'INV-PE-001',
    status: 'open',
    lineItems,
    totals,
    amountPaidCents: 0,
    amountDueCents: totals.totalCents,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function piSucceeded(opts: { piId: string; amount: number; methodType?: string }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        amount_received: opts.amount,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: opts.methodType ?? 'us_bank_account' } }] },
      },
    },
  };
}

function piProcessing(opts: { piId: string; amount: number }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        amount_received: 0, // funds not yet cleared
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
      },
    },
  };
}

function piFailed(opts: { piId: string; amount: number }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: 'card' } }] },
        last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
      },
    },
  };
}

function disputeCreated(opts: { piId: string }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'charge.dispute.created',
    data: {
      object: {
        id: `dp_${uuidv4()}`,
        amount: 10000,
        reason: 'fraudulent',
        payment_intent: opts.piId,
      },
    },
  };
}

describe('payment_intent.succeeded — async (ACH/bank) settlement', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice());
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('marks the invoice paid when ACH funds clear', async () => {
    const res = await postSigned(app, piSucceeded({ piId: 'pi_ach_1', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe('bank_transfer');
    expect(payments[0].providerReference).toBe('pi_ach_1');
  });

  it('B6 — audits the webhook-sourced payment with a system actor', async () => {
    const res = await postSigned(app, piSucceeded({ piId: 'pi_ach_audit', amount: 10000 }));
    expect(res.status).toBe(200);

    const events = auditRepo.getAll();
    const recorded = events.find((e) => e.eventType === 'payment.recorded');
    expect(recorded).toBeDefined();
    expect(recorded!.actorRole).toBe('system');
    expect(recorded!.actorId).toBe('stripe_webhook');
    expect(recorded!.entityType).toBe('invoice');
    expect(recorded!.entityId).toBe(INVOICE_ID);
    expect(recorded!.correlationId).toBe('pi_ach_audit');
    expect(recorded!.metadata).toMatchObject({
      amountCents: 10000,
      method: 'bank_transfer',
      providerReference: 'pi_ach_audit',
      newInvoiceStatus: 'paid',
    });

    const statusChange = events.find((e) => e.eventType === 'invoice.status_changed');
    expect(statusChange).toBeDefined();
    expect(statusChange!.actorRole).toBe('system');
    expect(statusChange!.correlationId).toBe('pi_ach_audit');
    expect(statusChange!.metadata).toMatchObject({ oldStatus: 'open', newStatus: 'paid' });
  });

  it('does not double-record when a card payment already recorded this payment_intent', async () => {
    // Simulate checkout.session.completed having already recorded the card.
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000, method: 'credit_card', providerReference: 'pi_card_1', processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );

    const res = await postSigned(app, piSucceeded({ piId: 'pi_card_1', amount: 10000 }));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
  });

  it('skips when invoice metadata is absent', async () => {
    const evt = piSucceeded({ piId: 'pi_x', amount: 10000 });
    (evt.data.object as { metadata?: unknown }).metadata = {};
    const res = await postSigned(app, evt);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
  });
});

describe('payment_intent.succeeded — ACH settlement fires the customer receipt (U7)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;
  let receipts: Array<{ tenantId: string; invoiceId: string; amountCents: number }>;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    receipts = [];
    await invoiceRepo.create(makeOpenInvoice());
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
      paymentReceiptNotifier: {
        notifyPaymentReceived: async (tenantId: string, invoiceId: string, amountCents: number) => {
          receipts.push({ tenantId, invoiceId, amountCents });
        },
      },
    });
  });

  it('sends NO receipt at processing time and exactly one at settlement', async () => {
    // 1. ACH initiated → processing: an in-flight row, but funds have not
    //    cleared, so the customer must NOT be told "payment received" yet.
    const p = await postSigned(app, piProcessing({ piId: 'pi_ach_settle', amount: 10000 }));
    expect(p.status).toBe(200);
    expect(receipts).toHaveLength(0);

    // 2. ACH clears → succeeded → settle: the receipt fires now.
    const s = await postSigned(app, piSucceeded({ piId: 'pi_ach_settle', amount: 10000 }));
    expect(s.status).toBe(200);
    expect(s.body.settled).toBe(true);
    expect(receipts).toEqual([{ tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000 }]);
  });

  it('does not double-send the receipt on a duplicate succeeded', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_ach_dup', amount: 10000 }));
    await postSigned(app, piSucceeded({ piId: 'pi_ach_dup', amount: 10000 }));
    const dup = await postSigned(app, piSucceeded({ piId: 'pi_ach_dup', amount: 10000 }));
    expect(dup.body.duplicate).toBe(true);
    expect(receipts).toHaveLength(1);
  });
});

describe('payment_intent.payment_failed', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeOpenInvoice());
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo: new InMemoryAuditRepository(),
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('records a failed attempt on a plain decline without touching the balance', async () => {
    const res = await postSigned(app, piFailed({ piId: 'pi_decline_1', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountDueCents).toBe(10000);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].providerReference).toBe('pi_decline_1');
  });

  it('reverses a settled payment (ACH return / NSF) and reopens the invoice', async () => {
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000, method: 'bank_transfer', providerReference: 'pi_nsf_1', processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    const res = await postSigned(app, piFailed({ piId: 'pi_nsf_1', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('ach_return');
  });
});

describe('charge.dispute.created — chargeback', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    await invoiceRepo.create(makeOpenInvoice());
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo: new InMemoryAuditRepository(),
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('reverses the disputed payment and reopens the invoice', async () => {
    await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000, method: 'credit_card', providerReference: 'pi_disp_1', processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );

    const res = await postSigned(app, disputeCreated({ piId: 'pi_disp_1' }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('dispute');
  });

  it('returns 500 (so Stripe retries) when the payment cannot be resolved yet', async () => {
    const res = await postSigned(app, disputeCreated({ piId: 'pi_unknown' }));
    expect(res.status).toBe(500);
  });
});
