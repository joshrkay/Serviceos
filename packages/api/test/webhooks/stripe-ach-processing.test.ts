/**
 * Route-level tests for the E2a one-time ACH processing lifecycle wired
 * into src/webhooks/routes.ts (Unit U2). These cover the full state machine
 * keyed on the existing payment row's status, across every Stripe delivery
 * ordering of {processing, succeeded, failed}:
 *
 *   - payment_intent.processing      — records a first-class `processing`
 *                                      row WITHOUT marking the invoice paid
 *                                      or firing a receipt; idempotent on
 *                                      redelivery; ACKs (no row) for a
 *                                      non-payable invoice or missing metadata.
 *   - payment_intent.succeeded       — UPGRADES an existing `processing`
 *                                      row to `completed` (never a duplicate),
 *                                      applying the full settled-money effect
 *                                      set; falls back to recordPayment for
 *                                      the card path (no prior row); ACKs
 *                                      (no 500, no 2nd row) for a stale
 *                                      `failed` row.
 *   - payment_intent.payment_failed  — fails an in-flight `processing` row
 *                                      (invoice untouched); idempotent on a
 *                                      `failed` row; still reverses a
 *                                      `completed` row (post-settlement NSF).
 *
 * Migration 178 added a partial UNIQUE index on
 * payments(tenant_id, reference_number); the assertions below pin that the
 * handler routes on the existing row's status so a redelivered/late event
 * never falls through to a plain INSERT (which would UNIQUE-violate → 500 →
 * Stripe retry storm). Every path must end in HTTP 200 with exactly one
 * payment row and a consistent invoice state.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryInvoiceRepository, Invoice, InvoiceStatus } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { recordFailedPaymentAttempt } from '../../src/payments/payment-service';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_ach_processing';
const TENANT = '33333333-3333-3333-3333-333333333333';
const INVOICE_ID = 'inv-ach-001';

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

function makeInvoice(status: InvoiceStatus = 'open', totalCents = 10000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  const paid = status === 'paid' ? totals.totalCents : 0;
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-ach-001',
    invoiceNumber: 'INV-ACH-001',
    status,
    lineItems,
    totals,
    amountPaidCents: paid,
    amountDueCents: totals.totalCents - paid,
    createdBy: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Stripe fires payment_intent.processing once an ACH debit is submitted but
// before funds clear. `payment_method_details.type = us_bank_account` makes
// mapStripePaymentMethod resolve to 'bank_transfer' (the ACH path).
function piProcessing(opts: { piId: string; amount: number; methodType?: string }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: opts.methodType ?? 'us_bank_account' } }] },
      },
    },
  };
}

function piSucceeded(opts: { piId: string; amount: number; amountReceived?: number; methodType?: string }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        amount_received: opts.amountReceived ?? opts.amount,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: opts.methodType ?? 'us_bank_account' } }] },
      },
    },
  };
}

function piFailed(opts: { piId: string; amount: number; methodType?: string }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: opts.methodType ?? 'us_bank_account' } }] },
        last_payment_error: { code: 'debit_not_authorized', message: 'The customer’s account could not be debited' },
      },
    },
  };
}

describe('ACH processing lifecycle — payment_intent.processing', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let receipt: { notifyPaymentReceived: ReturnType<typeof vi.fn> };
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    receipt = { notifyPaymentReceived: vi.fn().mockResolvedValue(undefined) };
    await invoiceRepo.create(makeInvoice('open'));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      paymentReceiptNotifier: receipt,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('records one processing row, invoice stays open, no receipt fires', async () => {
    const res = await postSigned(app, piProcessing({ piId: 'pi_ach_p1', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountDueCents).toBe(10000);
    expect(inv?.amountPaidCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');
    expect(payments[0].method).toBe('bank_transfer');
    expect(payments[0].providerReference).toBe('pi_ach_p1');

    // No money has cleared yet — no receipt, and the only audit event is
    // payment.processing (NOT payment.recorded).
    expect(receipt.notifyPaymentReceived).not.toHaveBeenCalled();
    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.processing')).toBe(true);
    expect(events.some((e) => e.eventType === 'payment.recorded')).toBe(false);
  });

  it('is idempotent — a duplicate processing event keeps exactly one row (no-op)', async () => {
    const first = await postSigned(app, piProcessing({ piId: 'pi_ach_dup', amount: 10000 }));
    expect(first.status).toBe(200);
    // Redelivery: same PaymentIntent id, distinct Stripe event id (so the
    // webhook-event-id dedup does NOT short-circuit; the domain any-row
    // guard / ON CONFLICT must).
    const second = await postSigned(app, piProcessing({ piId: 'pi_ach_dup', amount: 10000 }));
    expect(second.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');

    // The audit trail must not be duplicated either.
    const processingEvents = auditRepo.getAll().filter((e) => e.eventType === 'payment.processing');
    expect(processingEvents).toHaveLength(1);
  });

  it('ACKs 200 with NO row for an already-paid invoice', async () => {
    await invoiceRepo.update(TENANT, INVOICE_ID, {
      status: 'paid',
      amountPaidCents: 10000,
      amountDueCents: 0,
    });

    const res = await postSigned(app, piProcessing({ piId: 'pi_ach_paid', amount: 10000 }));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);

    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
  });

  it('ACKs 200 with NO row for a void invoice', async () => {
    await invoiceRepo.update(TENANT, INVOICE_ID, { status: 'void' });

    const res = await postSigned(app, piProcessing({ piId: 'pi_ach_void', amount: 10000 }));
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
  });

  it('skips (200) when invoice metadata is absent', async () => {
    const evt = piProcessing({ piId: 'pi_ach_nometa', amount: 10000 });
    (evt.data.object as { metadata?: unknown }).metadata = {};
    const res = await postSigned(app, evt);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
  });
});

describe('ACH processing lifecycle — processing -> succeeded (settlement)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let receipt: { notifyPaymentReceived: ReturnType<typeof vi.fn> };
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    receipt = { notifyPaymentReceived: vi.fn().mockResolvedValue(undefined) };
    await invoiceRepo.create(makeInvoice('open'));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      paymentReceiptNotifier: receipt,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('upgrades the processing row to completed, marks the invoice paid, fires the receipt', async () => {
    const p = await postSigned(app, piProcessing({ piId: 'pi_ach_settle', amount: 10000 }));
    expect(p.status).toBe(200);
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('open');
    expect(receipt.notifyPaymentReceived).not.toHaveBeenCalled();

    const s = await postSigned(app, piSucceeded({ piId: 'pi_ach_settle', amount: 10000 }));
    expect(s.status).toBe(200);

    // Exactly one row, upgraded in place to completed (never a duplicate).
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].providerReference).toBe('pi_ach_settle');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountDueCents).toBe(0);

    // The settled-money effect set ran: payment.recorded audit (SAME type
    // the card path emits, not a new payment.completed) + receipt fired once.
    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.recorded')).toBe(true);
    expect(events.some((e) => e.eventType === 'invoice.status_changed')).toBe(true);
    expect(receipt.notifyPaymentReceived).toHaveBeenCalledTimes(1);
    expect(receipt.notifyPaymentReceived).toHaveBeenCalledWith(TENANT, INVOICE_ID, 10000);
  });

  it('settles using amount_received when it drifts from the processing amount', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_ach_drift', amount: 10000 }));
    // Stripe's authoritative figure differs from the announced processing amount.
    const s = await postSigned(
      app,
      piSucceeded({ piId: 'pi_ach_drift', amount: 10000, amountReceived: 10000 }),
    );
    expect(s.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].amountCents).toBe(10000);
  });

  it('a duplicate succeeded after settlement is a no-op (still one completed row)', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_ach_dsettle', amount: 10000 }));
    const first = await postSigned(app, piSucceeded({ piId: 'pi_ach_dsettle', amount: 10000 }));
    expect(first.status).toBe(200);
    const second = await postSigned(app, piSucceeded({ piId: 'pi_ach_dsettle', amount: 10000 }));
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    // Receipt fired exactly once (on the first settlement), not twice.
    expect(receipt.notifyPaymentReceived).toHaveBeenCalledTimes(1);
  });
});

describe('ACH processing lifecycle — succeeded routing (card path + stale rows)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let receipt: { notifyPaymentReceived: ReturnType<typeof vi.fn> };
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    receipt = { notifyPaymentReceived: vi.fn().mockResolvedValue(undefined) };
    await invoiceRepo.create(makeInvoice('open'));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      paymentReceiptNotifier: receipt,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('REGRESSION: succeeded with NO prior row records a completed payment (card / missed-processing)', async () => {
    const s = await postSigned(app, piSucceeded({ piId: 'pi_card_only', amount: 10000, methodType: 'card' }));
    expect(s.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
    expect(payments[0].method).toBe('credit_card');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountDueCents).toBe(0);
    expect(receipt.notifyPaymentReceived).toHaveBeenCalledTimes(1);
  });

  it('succeeded with an existing FAILED row ACKs 200 (no 500, no 2nd row, invoice unchanged)', async () => {
    // A prior decline left a `failed` row for this PaymentIntent. A plain
    // INSERT via recordPayment would now UNIQUE-violate → 500. The handler
    // must route on status and ACK instead.
    await recordFailedPaymentAttempt(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'bank_transfer',
        providerReference: 'pi_failed_then_succeed',
        reason: 'debit_not_authorized',
      },
      paymentRepo,
      auditRepo,
    );

    const s = await postSigned(
      app,
      piSucceeded({ piId: 'pi_failed_then_succeed', amount: 10000 }),
    );
    expect(s.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountDueCents).toBe(10000);
    expect(receipt.notifyPaymentReceived).not.toHaveBeenCalled();
  });
});

describe('ACH processing lifecycle — processing -> failed', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeInvoice('open'));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('fails the in-flight processing row; invoice stays open and untouched', async () => {
    const p = await postSigned(app, piProcessing({ piId: 'pi_ach_fail', amount: 10000 }));
    expect(p.status).toBe(200);

    const f = await postSigned(app, piFailed({ piId: 'pi_ach_fail', amount: 10000 }));
    expect(f.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('debit_not_authorized');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(10000);

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.failed')).toBe(true);
  });

  it('a duplicate failed is a 200 no-op (still one failed row, no re-record)', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_ach_dfail', amount: 10000 }));
    const first = await postSigned(app, piFailed({ piId: 'pi_ach_dfail', amount: 10000 }));
    expect(first.status).toBe(200);
    // Redelivered failure (same PI id, fresh event id) must not UNIQUE-violate
    // via a second recordFailedPaymentAttempt INSERT.
    const second = await postSigned(app, piFailed({ piId: 'pi_ach_dfail', amount: 10000 }));
    expect(second.status).toBe(200);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
  });
});

describe('ACH processing lifecycle — payment_failed routing (post-settlement NSF regression)', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeInvoice('open'));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('REGRESSION: failed with an existing COMPLETED row reverses + reopens the invoice', async () => {
    // A settled payment (the invoice is paid), then a late ACH return / NSF.
    await recordPayment(
      {
        tenantId: TENANT,
        invoiceId: INVOICE_ID,
        amountCents: 10000,
        method: 'bank_transfer',
        providerReference: 'pi_nsf',
        processedBy: 'stripe_webhook',
      },
      invoiceRepo,
      paymentRepo,
      undefined,
      undefined,
      auditRepo,
    );
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    const f = await postSigned(app, piFailed({ piId: 'pi_nsf', amount: 10000 }));
    expect(f.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('ach_return');
  });
});
