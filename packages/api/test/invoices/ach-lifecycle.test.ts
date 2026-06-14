/**
 * U5 — ACH async-lifecycle handler tests.
 *
 * Drives the real Stripe webhook router (src/webhooks/routes.ts) against the
 * in-memory repos to prove the bank-debit settlement path end-to-end without
 * double-credit:
 *   - payment_intent.processing → in-flight 'processing' row + invoice credited
 *   - payment_intent.succeeded  → 'processing' flips to 'completed' once
 *   - duplicate processing / succeeded are idempotent
 *   - payment_intent.payment_failed while processing → reverse + reopen invoice
 *   - late ACH return AFTER settlement (completed) → reverse + reopen + audit
 *
 * Pattern mirrors test/webhooks/stripe-payment-events.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_ach_lifecycle';
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

function makeOpenInvoice(totalCents = 10000): Invoice {
  const lineItems = [buildLineItem('li-1', 'Service', 1, totalCents, 1, false)];
  const totals = calculateDocumentTotals(lineItems, 0, 0);
  return {
    id: INVOICE_ID,
    tenantId: TENANT,
    jobId: 'job-ach-001',
    invoiceNumber: 'INV-ACH-001',
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

function piProcessing(opts: { piId: string; amount: number }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        // For an initiated (not-yet-cleared) ACH debit, amount_received is 0.
        amount_received: 0,
        metadata: { tenant_id: TENANT, invoice_id: INVOICE_ID },
        charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
      },
    },
  };
}

function piSucceeded(opts: { piId: string; amount: number }) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: opts.piId,
        amount: opts.amount,
        amount_received: opts.amount,
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
        charges: { data: [{ payment_method_details: { type: 'us_bank_account' } }] },
        last_payment_error: { code: 'payment_intent_payment_attempt_failed', decline_code: 'debit_not_authorized' },
      },
    },
  };
}

describe('U5 — ACH async lifecycle', () => {
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

  it('processing → succeeded credits the invoice exactly once', async () => {
    // 1. processing: in-flight row + invoice credited (but NOT yet earned).
    const r1 = await postSigned(app, piProcessing({ piId: 'pi_ach', amount: 10000 }));
    expect(r1.status).toBe(200);

    let inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    expect(inv?.amountPaidCents).toBe(10000);
    expect(inv?.amountDueCents).toBe(0);

    let payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');
    expect(payments[0].method).toBe('bank_transfer');
    expect(payments[0].providerReference).toBe('pi_ach');
    // In-flight is excluded from gross revenue (status !== 'completed').
    expect(payments[0].status).not.toBe('completed');

    const processingEvt = auditRepo.getAll().find((e) => e.eventType === 'payment.processing');
    expect(processingEvt).toBeDefined();
    expect(processingEvt!.metadata).toMatchObject({ amountCents: 10000, method: 'bank_transfer' });

    // 2. succeeded: flip processing → completed, NO second credit.
    const r2 = await postSigned(app, piSucceeded({ piId: 'pi_ach', amount: 10000 }));
    expect(r2.status).toBe(200);
    expect(r2.body.settled).toBe(true);

    inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('paid');
    // Critical: still 10000 — credited exactly once, not 20000.
    expect(inv?.amountPaidCents).toBe(10000);

    payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');

    // Settlement is on the audit timeline distinct from processing.
    const settled = auditRepo
      .getAll()
      .find((e) => e.eventType === 'payment.recorded' && e.metadata?.settled === true);
    expect(settled).toBeDefined();
    expect(settled!.metadata).toMatchObject({ paymentId: payments[0].id });
  });

  it('duplicate payment_intent.processing is idempotent (one credit, one row)', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_dup', amount: 10000 }));
    const dup = await postSigned(app, piProcessing({ piId: 'pi_dup', amount: 10000 }));
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(10000);
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('processing');
  });

  it('duplicate payment_intent.succeeded after settle is idempotent', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_s', amount: 10000 }));
    await postSigned(app, piSucceeded({ piId: 'pi_s', amount: 10000 }));
    const dup = await postSigned(app, piSucceeded({ piId: 'pi_s', amount: 10000 }));
    expect(dup.status).toBe(200);
    // Already 'completed' — short-circuits as duplicate.
    expect(dup.body.duplicate).toBe(true);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.amountPaidCents).toBe(10000);
    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('completed');
  });

  it('processing → failed reverses the in-flight credit and reopens the invoice', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_fail', amount: 10000 }));
    expect((await invoiceRepo.findById(TENANT, INVOICE_ID))?.status).toBe('paid');

    const res = await postSigned(app, piFailed({ piId: 'pi_fail', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);
    expect(inv?.amountDueCents).toBe(10000);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('ach_return');
    expect(payments[0].reversedAt).not.toBeNull();

    const reversed = auditRepo.getAll().find((e) => e.eventType === 'payment.reversed');
    expect(reversed).toBeDefined();
    expect(reversed!.metadata).toMatchObject({ reason: 'ach_return', amountCents: 10000 });
  });

  it('late ACH return AFTER settlement (completed) reverses with audit', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_late', amount: 10000 }));
    await postSigned(app, piSucceeded({ piId: 'pi_late', amount: 10000 }));
    expect((await paymentRepo.findByInvoice(TENANT, INVOICE_ID))[0].status).toBe('completed');

    // Days later: the bank pulls the funds back.
    const res = await postSigned(app, piFailed({ piId: 'pi_late', amount: 10000 }));
    expect(res.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    expect(payments[0].reversalReason).toBe('ach_return');

    const reversed = auditRepo.getAll().find((e) => e.eventType === 'payment.reversed');
    expect(reversed).toBeDefined();
    const statusChange = auditRepo
      .getAll()
      .find((e) => e.eventType === 'invoice.status_changed' && e.metadata?.newStatus === 'open');
    expect(statusChange).toBeDefined();
  });

  it('duplicate ACH-return after a processing reversal is a no-op', async () => {
    await postSigned(app, piProcessing({ piId: 'pi_rdup', amount: 10000 }));
    await postSigned(app, piFailed({ piId: 'pi_rdup', amount: 10000 }));
    const dup = await postSigned(app, piFailed({ piId: 'pi_rdup', amount: 10000 }));
    expect(dup.status).toBe(200);

    const inv = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // Still reopened once — not double-decremented past zero / no re-credit.
    expect(inv?.status).toBe('open');
    expect(inv?.amountPaidCents).toBe(0);

    const payments = await paymentRepo.findByInvoice(TENANT, INVOICE_ID);
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('failed');
    // Exactly one reversal audit event.
    const reversals = auditRepo.getAll().filter((e) => e.eventType === 'payment.reversed');
    expect(reversals).toHaveLength(1);
  });

  it('skips when invoice metadata is absent on processing', async () => {
    const evt = piProcessing({ piId: 'pi_nometa', amount: 10000 });
    (evt.data.object as { metadata?: unknown }).metadata = {};
    const res = await postSigned(app, evt);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
    expect(await paymentRepo.findByInvoice(TENANT, INVOICE_ID)).toHaveLength(0);
  });
});
