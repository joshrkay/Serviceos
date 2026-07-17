/**
 * TEST-01/03 — event-ORDERING coverage for the two money-reversal Stripe
 * webhook branches (`charge.dispute.created` -> reversePayment,
 * `charge.refunded` -> recordRefund) when TWO events land on the SAME
 * underlying charge/payment_intent. Complements:
 *   - webhooks/charge-refunded.test.ts (single-event refund branches)
 *   - webhooks/stripe-payment-events.test.ts (single-event dispute branch)
 *   - payments/payment-reversal-selfheal.test.ts (service-layer redelivery)
 *   - webhooks/durable-idempotency.test.ts (throw-mid-processing redelivery)
 *
 * These are genuinely DIFFERENT Stripe event ids (not a literal retry of the
 * same event), so the outer webhookRepo (source, idempotencyKey) dedup does
 * NOT short-circuit them — whatever protection exists has to come from the
 * inner guards (reversePaymentAtomic's compare-and-swap, recordRefund's
 * per-stripeRefundId check).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter, WebhookRouterDeps } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryInvoiceRepository, Invoice } from '../../src/invoices/invoice';
import { InMemoryPaymentRepository, recordPayment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';
import { buildLineItem, calculateDocumentTotals } from '../../src/shared/billing-engine';

const STRIPE_SECRET = 'whsec_test_dispute_refund_ordering';
const TENANT = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = 'inv-order-001';

function buildApp(deps: WebhookRouterDeps) {
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
    jobId: 'job-order-001',
    invoiceNumber: 'INV-ORDER-001',
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

function disputeCreatedEvent(piId: string) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'charge.dispute.created',
    data: {
      object: {
        id: `dp_${uuidv4()}`,
        amount: 10000,
        reason: 'fraudulent',
        payment_intent: piId,
      },
    },
  };
}

function chargeRefundedEvent(piId: string, refundCents: number, refundId?: string) {
  return {
    id: `evt_${uuidv4()}`,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${uuidv4()}`,
        payment_intent: piId,
        metadata: { tenant_id: TENANT },
        refunds: {
          data: [
            {
              id: refundId ?? `re_${uuidv4()}`,
              amount: refundCents,
              created: Math.floor(Date.now() / 1000),
              status: 'succeeded',
              payment_intent: piId,
              metadata: { tenant_id: TENANT },
            },
          ],
        },
      },
    },
  };
}

describe('TEST-01/03 — dispute/refund ordering on the same charge', () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;
  const PI_ID = 'pi_order_shared';

  beforeEach(async () => {
    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    await invoiceRepo.create(makeOpenInvoice(10000));
    app = buildApp({
      invoiceRepo,
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    });
  });

  it('TWO charge.dispute.created events (different Stripe event ids) on the same payment_intent — the second is a no-op, no double-reversal', async () => {
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000, method: 'credit_card', providerReference: PI_ID, processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );

    const first = await postSigned(app, disputeCreatedEvent(PI_ID));
    expect(first.status).toBe(200);
    const afterFirst = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(afterFirst?.status).toBe('open');
    expect(afterFirst?.amountPaidCents).toBe(0);
    const reversedAtAfterFirst = (await paymentRepo.findById(TENANT, payment.id))?.reversedAt;
    expect(reversedAtAfterFirst).toBeTruthy();
    const reversedAuditCountAfterFirst = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'payment.reversed').length;
    expect(reversedAuditCountAfterFirst).toBe(1);

    // A SECOND, genuinely distinct dispute notification for the same
    // payment_intent (e.g. Stripe re-notifying, or a duplicate dispute
    // object) — NOT a literal event-id retry, so the outer dedup doesn't
    // catch it. reversePaymentAtomic's guard (already reversed) must.
    const second = await postSigned(app, disputeCreatedEvent(PI_ID));
    expect(second.status).toBe(200);

    const afterSecond = await invoiceRepo.findById(TENANT, INVOICE_ID);
    // Never double-decremented / never goes negative.
    expect(afterSecond?.amountPaidCents).toBe(0);
    expect(afterSecond?.amountDueCents).toBeGreaterThanOrEqual(0);
    expect(afterSecond?.status).toBe('open');

    const paymentAfterSecond = await paymentRepo.findById(TENANT, payment.id);
    expect(paymentAfterSecond?.status).toBe('failed');
    // reversedAt is untouched by the second (no-op) delivery.
    expect(paymentAfterSecond?.reversedAt?.toISOString()).toBe(reversedAtAfterFirst?.toISOString());

    // No second 'payment.reversed' audit — the self-heal path only writes
    // an audit event when it actually repairs something, and the ledger
    // was already consistent after the first reversal.
    const reversedAuditCountAfterSecond = auditRepo
      .getAll()
      .filter((e) => e.eventType === 'payment.reversed').length;
    expect(reversedAuditCountAfterSecond).toBe(1);
  });

  it('dispute-before-refund: a chargeback reverses the payment; a LATER charge.refunded for the same payment_intent is still recorded by recordRefund (pins current behavior — see risk note)', async () => {
    // KNOWN GAP (flagged for product/eng review, not fixed here — this test
    // file may only add test coverage, not modify src/):
    //
    // recordRefund()/incrementRefundAtomic() validate ONLY the refund-cap
    // invariant (refundedAmountCents + refundCents <= amountCents); neither
    // checks payment.status or payment.reversedAt. So once a chargeback has
    // already reversed a payment (status: 'failed', reversedAt set), a
    // late-arriving charge.refunded for the SAME payment_intent still
    // increments refundedAmountCents on that already-reversed row. This
    // does NOT create a negative invoice balance (recordRefund never
    // touches invoiceRepo — only reversePayment does), but it does leave a
    // confusing payment row (status: 'failed' + reversedAmountCents > 0)
    // and double-counts the "money that left the business" narrative
    // (once via the reversal, once via the refund). Pinning the OBSERVED
    // behavior here so a future guard change shows up as an intentional
    // diff instead of silently drifting.
    const { payment } = await recordPayment(
      { tenantId: TENANT, invoiceId: INVOICE_ID, amountCents: 10000, method: 'credit_card', providerReference: PI_ID, processedBy: 'stripe_webhook' },
      invoiceRepo,
      paymentRepo,
    );

    const disputeRes = await postSigned(app, disputeCreatedEvent(PI_ID));
    expect(disputeRes.status).toBe(200);
    const afterDispute = await paymentRepo.findById(TENANT, payment.id);
    expect(afterDispute?.status).toBe('failed');
    expect(afterDispute?.reversedAt).toBeTruthy();

    const refundRes = await postSigned(app, chargeRefundedEvent(PI_ID, 2000));
    expect(refundRes.status).toBe(200);

    const afterRefund = await paymentRepo.findById(TENANT, payment.id);
    // Current (observed) behavior: the refund IS recorded on top of the
    // already-reversed payment.
    expect(afterRefund?.refundedAmountCents).toBe(2000);
    expect(afterRefund?.status).toBe('failed'); // still reversed — refund doesn't flip status

    // The invoice is NOT affected by the refund (recordRefund doesn't
    // touch invoiceRepo at all) — it stays exactly as the reversal left
    // it. This is the one invariant that must hold regardless: no
    // negative balance.
    const invoice = await invoiceRepo.findById(TENANT, INVOICE_ID);
    expect(invoice?.amountPaidCents).toBe(0);
    expect(invoice?.amountDueCents).toBeGreaterThanOrEqual(0);
  });
});
