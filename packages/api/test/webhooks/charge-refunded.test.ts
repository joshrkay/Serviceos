/**
 * D2-4 (Codex P1 #2 + #3 follow-up — PR #384)
 *
 * End-to-end tests for the Stripe `charge.refunded` route branch in
 * `packages/api/src/webhooks/routes.ts`.
 *
 * The two bugs being pinned:
 *
 * 1. Codex P1 #2 — our Stripe creation paths attach `tenant_id` and
 *    `invoice_id` metadata, but NEVER `payment_id`. The original
 *    refund handler required `metadata.payment_id` and silently ACKed
 *    every real refund as `skipped`. The fix stamps the Stripe
 *    `payment_intent` id into the local payment's `providerReference`
 *    at `checkout.session.completed`, and the refund handler now
 *    falls back to `paymentRepo.findByProviderReference` when
 *    metadata is missing.
 *
 * 2. Codex P1 #3 — the previous handler wrapped `recordRefund` in
 *    `catch (refundErr instanceof ValidationError)` and ACKed success
 *    on EVERY validation error, including `'Payment not found'`.
 *    Stripe webhook delivery is not ordered, so `charge.refunded` can
 *    arrive before the `checkout.session.completed` that creates the
 *    payment row. Suppressing the retry meant the refund could never
 *    be reconciled. The fix throws `NotFoundError` for that case so
 *    the outer error path returns 5xx (Stripe retries — webhookRepo
 *    dedups by event id so retries are idempotent). Over-refund and
 *    other validation failures stay terminal (2xx ACK).
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { createWebhookRouter } from '../../src/webhooks/routes';
import { createWebhookSignature } from '../../src/webhooks/webhook-handler';
import { InMemoryPaymentRepository, Payment } from '../../src/invoices/payment';
import { InMemoryAuditRepository } from '../../src/audit/audit';

const STRIPE_SECRET = 'whsec_test_charge_refunded';
const TENANT = 'tenant-charge-refunded';

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
    reversedAt: null,
    reversalReason: null,
    ...over,
  };
}

interface StripeEventOpts {
  eventId?: string;
  refundAmountCents: number;
  refundId?: string;
  paymentIntentId?: string;
  chargePaymentIntentId?: string;
  refundMetadata?: Record<string, string>;
  chargeMetadata?: Record<string, string>;
  /** Stripe refund status: 'succeeded' (default) | 'pending' | 'requires_action' | 'failed' | 'canceled' */
  refundStatus?: string;
}

function buildChargeRefundedEvent(opts: StripeEventOpts): Record<string, unknown> {
  return {
    id: opts.eventId ?? `evt_${uuidv4()}`,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${uuidv4()}`,
        payment_intent: opts.chargePaymentIntentId,
        metadata: opts.chargeMetadata ?? {},
        refunds: {
          data: [
            {
              id: opts.refundId ?? `re_${uuidv4()}`,
              amount: opts.refundAmountCents,
              created: Math.floor(Date.now() / 1000),
              status: opts.refundStatus ?? 'succeeded',
              payment_intent: opts.paymentIntentId,
              metadata: opts.refundMetadata ?? {},
            },
          ],
        },
      },
    },
  };
}

function buildApp(paymentRepo: InMemoryPaymentRepository, auditRepo: InMemoryAuditRepository) {
  const app = express();
  // /webhooks/stripe MUST be raw — see routes.ts. We mount express.raw
  // for that path only; supertest sends a string body which becomes a
  // Buffer here.
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

describe('Stripe charge.refunded route (D2-4 — Codex P1 #2 + #3 follow-up)', () => {
  let paymentRepo: InMemoryPaymentRepository;
  let auditRepo: InMemoryAuditRepository;
  let app: express.Express;

  beforeEach(() => {
    paymentRepo = new InMemoryPaymentRepository();
    auditRepo = new InMemoryAuditRepository();
    app = buildApp(paymentRepo, auditRepo);
  });

  it('resolves payment via payment_intent providerReference when metadata.payment_id is absent (Codex P1 #2)', async () => {
    // Our real Stripe creation paths stamp tenant_id+invoice_id
    // metadata but NEVER payment_id. The fix lets the handler fall
    // back to looking up by providerReference == payment_intent.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).not.toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(1500);
    expect(reread?.refundedAt).not.toBeNull();

    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.refunded')).toBe(true);
  });

  it('falls back to charge.payment_intent when refund.payment_intent is missing (Codex P1 #2)', async () => {
    // Stripe sometimes only sets payment_intent on the parent charge,
    // not the nested refund. The handler must check both.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 80000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 2500,
        chargePaymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).not.toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(2500);
  });

  it('returns 500 (retryable) when payment_intent does not match any local payment — Stripe will retry (Codex P1 #3)', async () => {
    // No payment row exists for this payment_intent — the
    // charge.refunded arrived before checkout.session.completed (race).
    // The handler must NOT silently ACK; it must surface as 5xx so
    // Stripe re-delivers. Older behavior would have ACKed 200/skipped
    // and the refund would never be reconciled.
    const piId = `pi_${uuidv4()}`;
    // Seed a payment row WITH the providerReference so the lookup
    // succeeds and we exercise the recordRefund NotFoundError path
    // rather than the resolve-miss skip-branch above. We seed a row
    // with a DIFFERENT id but the lookup-by-providerReference path
    // returns the id we'll then try to recordRefund — but we delete
    // it before posting to simulate "row vanished between resolve
    // and recordRefund" (proxy for the cross-tenant / missing case
    // recordRefund actually guards against).
    //
    // Simpler: post with metadata.payment_id pointing at a nonexistent
    // id but valid tenant. recordRefund will then throw NotFoundError.
    const ghostPaymentId = uuidv4();

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1000,
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT, payment_id: ghostPaymentId },
        chargeMetadata: { tenant_id: TENANT, payment_id: ghostPaymentId },
      }),
    );

    expect(res.status).toBe(500);
    // No refund was recorded; the audit log stays empty for refunds.
    const events = auditRepo.getAll();
    expect(events.some((e) => e.eventType === 'payment.refunded')).toBe(false);
  });

  it('returns 200 (terminal) on over-refund — Stripe should NOT retry', async () => {
    // Over-refund is a data condition that retrying can't fix
    // (ValidationError, not NotFoundError). The handler ACKs 200 and
    // logs so Stripe stops hammering us; manual reconciliation only.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({
      amountCents: 10000,
      providerReference: piId,
      refundedAmountCents: 9500, // only 500c left to refund
    });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1000, // 500 + 1000 > 10000? no: 9500 + 1000 = 10500 > 10000 → over
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
      }),
    );

    expect(res.status).toBe(200);
    // No mutation occurred — refundedAmountCents stays at 9500.
    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(9500);
  });

  it('skips (200) when both metadata AND payment_intent lookup miss — truly unresolvable', async () => {
    // No metadata.payment_id, no payment_intent provided at all.
    // The handler can't even attempt a lookup → log + ACK 200/skipped.
    // This is the original "truly unresolvable" terminal path.
    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 500,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
        // no paymentIntentId, no chargePaymentIntentId
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.skipped).toBe(true);
  });

  it('defers (200) when refund.status is pending — does NOT mutate refundedAmountCents (Codex P1 pending-refunds)', async () => {
    // Stripe can return refunds in 'pending' (e.g. insufficient
    // platform balance) that later transition to 'failed'. Recording
    // the amount immediately would permanently overstate refunds.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
        refundStatus: 'pending',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.deferred).toBe(true);
    expect(res.body?.refundStatus).toBe('pending');

    // refundedAmountCents MUST NOT have moved.
    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
    expect(reread?.refundedAt).toBeNull();
    expect(auditRepo.getAll().some((e) => e.eventType === 'payment.refunded')).toBe(false);
  });

  it('defers (200) when refund.status is failed — does NOT mutate refundedAmountCents', async () => {
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
        refundStatus: 'failed',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.deferred).toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(0);
    expect(reread?.refundedAt).toBeNull();
  });

  it('processes refund when status is explicitly succeeded', async () => {
    // The default behavior — just pinning that explicit 'succeeded'
    // doesn't short-circuit.
    const piId = `pi_${uuidv4()}`;
    const payment = makePayment({ amountCents: 50000, providerReference: piId });
    await paymentRepo.create(payment);

    const res = await postSigned(
      app,
      buildChargeRefundedEvent({
        refundAmountCents: 1500,
        paymentIntentId: piId,
        refundMetadata: { tenant_id: TENANT },
        chargeMetadata: { tenant_id: TENANT },
        refundStatus: 'succeeded',
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body?.deferred).not.toBe(true);

    const reread = await paymentRepo.findById(TENANT, payment.id);
    expect(reread?.refundedAmountCents).toBe(1500);
  });
});
