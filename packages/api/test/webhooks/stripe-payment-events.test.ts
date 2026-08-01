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

function piSucceeded(opts: {
  piId: string;
  amount: number;
  methodType?: string;
  /**
   * Top-level `account` on the event envelope, as Stripe delivers it from a
   * "Connected accounts" webhook destination for a Connect direct charge. The
   * settlement path keys off data.object.metadata, so this must be inert to
   * routing — that origin-agnosticism is exactly what the Connect-scoped tests
   * below assert.
   */
  account?: string;
  eventId?: string;
}) {
  return {
    id: opts.eventId ?? `evt_${uuidv4()}`,
    type: 'payment_intent.succeeded',
    ...(opts.account ? { account: opts.account } : {}),
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

// U6 — Connect direct charges settle through the SAME webhook ledger.
//
// The primary customer path is an Elements PaymentIntent on the tenant's
// connected account (a Stripe "direct charge"). Stripe delivers the resulting
// `payment_intent.succeeded` from the *connected-accounts* destination, so the
// event envelope carries a top-level `account: acct_…`. The settlement branch
// in routes.ts routes purely off `data.object.metadata` (tenant_id/invoice_id)
// and never reads `event.account` for payment settlement, so a connected-origin
// event must settle the invoice identically to a platform one. These tests pin
// that origin-agnosticism — the premise of "Connect direct charges settle
// through the existing ledger" (prd-stripe-trades-payments §acceptance, plan U6).
describe('payment_intent.succeeded — Connect direct charge (connected-account delivery)', () => {
  const CONNECTED_ACCOUNT = 'acct_connect_w1_2';
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

  it('settles an open invoice from a connected-account card charge (event.account present)', async () => {
    const res = await postSigned(
      app,
      piSucceeded({ piId: 'pi_connect_card_1', amount: 10000, methodType: 'card', account: CONNECTED_ACCOUNT }),
    );
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountDueCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    // Card-on-Connect settles as a card payment, not ACH — proves the method
    // mapping still reads data.object, unaffected by the connected origin.
    expect(payments[0].method).toBe('credit_card');
    expect(payments[0].providerReference).toBe('pi_connect_card_1');
  });

  it('is idempotent on a re-delivered connected-account event id', async () => {
    const event = piSucceeded({
      piId: 'pi_connect_idem',
      amount: 10000,
      methodType: 'card',
      account: CONNECTED_ACCOUNT,
      eventId: 'evt_connect_idem',
    });

    const first = await postSigned(app, event);
    expect(first.status).toBe(200);

    const second = await postSigned(app, event);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(10000);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(1);
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

// U5 — the ACH payer's RECEIPT on settlement.
//
// Regression: the `existing.status === 'processing'` settle branch returned
// without ever reaching deps.paymentReceiptNotifier, while the recordPayment
// branch directly below it passed the notifier through. Net effect in
// production: ACH payers' invoices went to 'paid' in silence; card payers got
// a receipt. These tests pin the settle path to the SAME receipt the card path
// sends, and pin the redelivery guard.
function piProcessing(opts: { piId: string; amount: number; eventId?: string }) {
  return {
    id: opts.eventId ?? `evt_${uuidv4()}`,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        amount_received: 0,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
      },
    },
  };
}

describe('payment_intent.succeeded — ACH settlement sends the customer receipt', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;
  let receipts: Array<{
    tenantId: string;
    invoiceId: string;
    amountCents: number;
    paymentId: string;
  }>;

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
        async notifyPaymentReceived(tenantId, invoiceId, amountCents, paymentId) {
          receipts.push({ tenantId, invoiceId, amountCents, paymentId });
        },
      },
    });
  });

  it('notifies the receipt notifier when a processing ACH payment settles', async () => {
    // Bank debit initiated — records the IN-FLIGHT row, deliberately no comms.
    const initiated = await postSigned(app, piProcessing({ piId: 'pi_ach_r1', amount: 10000 }));
    expect(initiated.status).toBe(200);
    expect(receipts).toHaveLength(0);

    const inFlight = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].status).toBe('processing');

    // Funds clear — settle flips 'processing' -> 'completed' AND sends the
    // receipt the card path sends.
    const settled = await postSigned(app, piSucceeded({ piId: 'pi_ach_r1', amount: 10000 }));
    expect(settled.status).toBe(200);
    expect(settled.body.settled).toBe(true);

    const rows = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');

    // Same shape the card path passes: tenant, invoice, the SETTLED ROW's
    // amount, and payment.id as the per-occurrence claim token.
    expect(receipts).toEqual([
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        paymentId: rows[0].id,
      },
    ]);
  });

  it('does not send a second receipt when Stripe redelivers payment_intent.succeeded', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_ach_r2', amount: 10000 }));
    const first = await postSigned(app, piSucceeded({ piId: 'pi_ach_r2', amount: 10000 }));
    expect(first.body.settled).toBe(true);
    expect(receipts).toHaveLength(1);

    // Redelivered under a DISTINCT event id, so the webhook-event-id dedup
    // cannot be what saves us — the payment-state guard must.
    const redelivered = await postSigned(app, piSucceeded({ piId: 'pi_ach_r2', amount: 10000 }));
    expect(redelivered.status).toBe(200);
    expect(redelivered.body.duplicate).toBe(true);
    expect(receipts).toHaveLength(1);
  });

  it('a receipt-send failure does not fail the webhook (Stripe must not retry a settled payment)', async () => {
    const throwingApp = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
      paymentReceiptNotifier: {
        async notifyPaymentReceived() {
          throw new Error('comms provider down');
        },
      },
    });

    await postSigned(throwingApp, piProcessing({ piId: 'pi_ach_r3', amount: 10000 }));
    const res = await postSigned(throwingApp, piSucceeded({ piId: 'pi_ach_r3', amount: 10000 }));

    expect(res.status).toBe(200);
    expect(res.body.settled).toBe(true);

    // The settlement still stands — the money is not held hostage by comms.
    const rows = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(rows[0].status).toBe('completed');
  });

  it('sends no receipt at payment_intent.processing — only once the money clears', async () => {
    const res = await postSigned(app, piProcessing({ piId: 'pi_ach_r4', amount: 10000 }));
    expect(res.status).toBe(200);

    const rows = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(rows[0].status).toBe('processing');
    // The invoice is credited in-flight, but the customer is told nothing yet.
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');
    expect(receipts).toHaveLength(0);
  });
});
