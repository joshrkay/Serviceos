/**
 * D2-4 (Codex P1 follow-up — PR #384)
 *
 * End-to-end tests for the Stripe `charge.refund.updated` route branch
 * in `packages/api/src/webhooks/routes.ts`.
 *
 * Background: a prior fix made non-`succeeded` refunds (e.g. ACH/bank
 * transfer `pending`) defer with HTTP 200 + `deferred: true`. The
 * original assumption — that Stripe would re-fire `charge.refunded`
 * once those refunds settled — was wrong. Stripe instead fires
 * `charge.refund.updated`, a different event type. Without a handler
 * for it, those deferred refunds would never be recorded; revenue
 * and tax reporting would stay permanently understated for ACH refunds.
 *
 * The handler mirrors `charge.refunded` but:
 * - The event payload is the Refund directly (no parent Charge wrapper).
 * - Tenant resolution falls back to a CROSS-TENANT lookup by
 *   payment_intent → reference_number (the Refund payload doesn't
 *   carry the parent charge's metadata.tenant_id).
 *
 * Per-refund idempotency lives in `recordRefund()` and is covered by
 * test 2 here (same refund arriving via both event types must NOT
 * double-count) plus the unit test in `payment-refund.test.ts`.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const STRIPE_SECRET = 'whsec_test_charge_refund_updated';
const TENANT = 'tenant-charge-refund-updated';

function makePayment(over: Partial<Payment> = {}): Payment {
  const now = new Date('2026-05-01T12:00:00Z');
  return {
    id: uuidv4(),
    tenantId: TENANT,
    invoiceId: 'inv-1',
    amountCents: 50000,
    method: 'credit_card',
    status: 'completed',
    receivedAt: now,
    processedBy: 'stripe_webhook',
    createdAt: now,
    updatedAt: now,
    refundedAmountCents: 0,
    refundedAt: null,
    lastRefundStripeId: null,
    ...over,
  };
}

interface RefundUpdatedOpts {
  eventId?: string;
  refundAmountCents: number;
  refundId?: string;
  paymentIntentId?: string;
  refundMetadata?: Record<string, string>;
  refundStatus?: string;
}

function buildChargeRefundUpdatedEvent(opts: RefundUpdatedOpts): Record<string, unknown> {
  return {
    id: opts.eventId ?? `evt_${uuidv4()}`,
    type: 'charge.refund.updated',
    data: {
      object: {
        // For charge.refund.updated the event.data.object IS the Refund —
        // not a Charge with nested refunds[].
        id: opts.refundId ?? `re_${uuidv4()}`,
        amount: opts.refundAmountCents,
        created: Math.floor(Date.now() / 1000),
        status: opts.refundStatus ?? 'succeeded',
        payment_intent: opts.paymentIntentId,
        metadata: opts.refundMetadata ?? {},
      },
    },
  };
}

function buildChargeRefundedEvent(opts: {
  eventId?: string;
  refundAmountCents: number;
  refundId?: string;
  paymentIntentId?: string;
  refundStatus?: string;
}): Record<string, unknown> {
  return {
    id: opts.eventId ?? `evt_${uuidv4()}`,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${uuidv4()}`,
        payment_intent: opts.paymentIntentId,
        metadata: { tenant_id: TENANT },
        refunds: {
          data: [
            {
              id: opts.refundId ?? `re_${uuidv4()}`,
              amount: opts.refundAmountCents,
              created: Math.floor(Date.now() / 1000),
              status: opts.refundStatus ?? 'succeeded',
              payment_intent: opts.paymentIntentId,
              metadata: { tenant_id: TENANT },
            },
          ],
        },
      },
    },
  };
}

function buildApp(paymentRepo: InMemoryPaymentRepository, auditRepo: InMemoryAuditRepository) {
  const app = express();
  app.use('/webhooks/stripe', express.raw({ type: '*/*' }));
  app.use(
    '/webhooks',
    createWebhookRouter({} as any, {
      paymentRepo,
      auditRepo,
      stripeWebhookSecret: STRIPE_SECRET,
    }),
  );
  return app;
}

async function postSigned(app: express.Express, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const signature = createWebhookSignature(rawBody, STRIPE_SECRET);
  return request(app)
    .post('/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('content-type', 'application/json')
    .send(rawBody);
}

describe('Stripe charge.refund.updated route (D2-4 — Codex P1 follow-up)', () => {
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(() => {
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    app = buildApp(paymentRepo, auditRepo);
  });

  it('records refund when status=succeeded for a known payment_intent (cross-tenant lookup)', async () => {
    // The event payload doesn't carry tenant metadata — we must
    // resolve tenant via payment_intent -> reference_number.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundUpdatedEvent({
        refundAmountCents: 2500,
        paymentIntentId: piId,
        // NOTE: deliberately no refundMetadata — proves cross-tenant lookup works.
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).not.toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(2500);
    expect(reread?.refundedAt).not.toBeNull();

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.refunded')).toBe(true);
  });

  it('is idempotent when the same refund arrives via charge.refunded then charge.refund.updated', async () => {
    // The two events have different event.ids — webhook-event-id dedup
    // doesn't help. Per-refund idempotency in recordRefund() must
    // prevent double-counting.
    const piId = `pi_${uuidv4()}`;
    const refundId = `re_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    // First: charge.refunded records the refund.
    const res1 = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1500,
        refundId,
        paymentIntentId: piId,
      }),
    );
    expect(res1.status).toBe(200);

    const after1 = await paymentRepo.findById(TENANT, payment.id);
    expect(after1?.refundedAmountCents).toBe(1500);
    expect(after1?.lastRefundStripeId).toBe(refundId);
    const auditCountAfter1 = auditRepo.getAll().filter((e) => e.eventType === 'payment.refunded').length;
    expect(auditCountAfter1).toBe(1);

    // Second: same refund.id arrives via charge.refund.updated.
    // Must short-circuit — NO double-count, NO duplicate audit event.
    const res2 = await postSigned(
      app,
      buildChargeRefundUpdatedEvent({
        refundAmountCents: 1500,
        refundId,
        paymentIntentId: piId,
      }),
    );
    expect(res2.status).toBe(200);

    const after2 = await paymentRepo.findById(TENANT, payment.id);
    expect(after2?.refundedAmountCents).toBe(1500); // unchanged
    expect(after2?.lastRefundStripeId).toBe(refundId);
    const auditCountAfter2 = auditRepo.getAll().filter((e) => e.eventType === 'payment.refunded').length;
    expect(auditCountAfter2).toBe(1); // no new audit event
  });

  it('skips (200) when refund.status is pending — no mutation', async () => {
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundUpdatedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundStatus: 'pending',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
    expect(reread?.refundedAt).toBeNull();
    expect(auditRepo.getAll().some((e) => e.eventType === 'payment.refunded')).toBe(false);
  });

  it('skips (200) when refund.status is failed — no mutation', async () => {
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundUpdatedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundStatus: 'failed',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
    expect(reread?.refundedAt).toBeNull();
  });

  it('returns 500 (retryable) when no payment matches the payment_intent — out-of-order delivery', async () => {
    // No payment was ever recorded for this payment_intent — possibly
    // the checkout.session.completed event hasn't arrived yet. The
    // handler must surface as 5xx so Stripe re-delivers.
    const piId = `pi_${uuidv4()}`;

    const res = await postSigned(
      app,
      buildChargeRefundUpdatedEvent({
        refundAmountCents: 1000,
        paymentIntentId: piId,
      }),
    );

    expect(res.status).toBe(500);
    // No refund was recorded.
    expect(auditRepo.getAll().some((e) => e.eventType === 'payment.refunded')).toBe(false);
  });
});
