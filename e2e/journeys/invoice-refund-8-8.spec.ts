import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { hasViteClerkKey } from '../helpers/clerk-key';
import {
  API_URL,
  STRIPE_WEBHOOK_SECRET,
  bootstrapOwner,
  seedCustomerJob,
  seedIssuedInvoice,
  stripeSignature,
  queryAsTenant,
  pollUntilOk,
  pollRows,
} from '../fixtures/money-lane-8-8';

/**
 * 8.8 — rung-5 reachability: "a refund adjusts the record without lying
 * about what happened". PR #1055's `integration/payment-refunds.test.ts`
 * already proves the (tenant_id, stripe_refund_id) idempotency ledger at
 * real Postgres by calling `recordRefund` directly, in-process. This spec
 * drives the SAME capability through the real surface Stripe actually
 * uses: a signed `charge.refunded` webhook posted straight to the real
 * running `/webhooks/stripe` route — TWO concurrent deliveries of the
 * IDENTICAL `stripe_refund_id`, exactly the race the acceptance names —
 * after the invoice was settled the real way (a signed
 * `checkout.session.completed`, same recipe as
 * e2e/journeys/public-invoice-pay-link.spec.ts's 8.4 spec).
 *
 * No live Stripe call: this route only reads the signed event body and
 * writes to Postgres, so no STRIPE_SECRET_KEY is needed (matches 8.4's
 * webhook-settlement half, which needed only STRIPE_WEBHOOK_SECRET).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test.describe('a refund adjusts the record without lying (8.8) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!STRIPE_WEBHOOK_SECRET;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), STRIPE_WEBHOOK_SECRET (must be set before ' +
      '`npx playwright test` starts), and E2E_USE_TEST_DB=true with DATABASE_URL pointing at the ' +
      'test container.',
  );

  test('two concurrent deliveries of the same stripe_refund_id credit exactly once; the payment status never flips; a neighbour tenant sees neither the claim nor the audit row', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    // ── Tenant A: settle a $500 invoice for real, the same way 8.4 does ──
    const tenantA = await bootstrapOwner(request, 'a', 'Refundable HVAC 8.8');
    const seedA = await seedCustomerJob(request, tenantA, 'Devon', '8.8 refund journey');
    const invoiceA = await seedIssuedInvoice(request, tenantA, seedA.jobId, 50_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceA.invoiceId}`, tenantA.authHeaders);

    const settleEventId = `evt_settle_${randomUUID()}`;
    const settleBody = JSON.stringify({
      id: settleEventId,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenantA.tenantId, invoice_id: invoiceA.invoiceId },
          amount_total: invoiceA.totalCents,
          payment_status: 'paid',
          payment_intent: `pi_${settleEventId}`,
        },
      },
    });
    const settleRes = await request.post(`${API_URL}/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(settleBody, STRIPE_WEBHOOK_SECRET!),
      },
      data: settleBody,
    });
    expect(settleRes.ok(), `settle webhook -> ${settleRes.status()} ${await settleRes.text()}`).toBeTruthy();

    const paidInvoice = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await paidInvoice.json()) as { status: string }).status).toBe('paid');

    const paymentRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id, amount_cents, status FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(paymentRows).toHaveLength(1);
    const paymentId = paymentRows[0].id as string;
    expect(paymentId).toMatch(UUID_RE);
    expect(paymentRows[0].status).toBe('completed');

    // ── Tenant B: a wholly independent, untouched payment ────────────────
    const tenantB = await bootstrapOwner(request, 'b', 'Untouched Plumbing 8.8');
    const seedB = await seedCustomerJob(request, tenantB, 'Jamie', '8.8 neighbour journey');
    const invoiceB = await seedIssuedInvoice(request, tenantB, seedB.jobId, 20_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceB.invoiceId}`, tenantB.authHeaders);
    const settleEventIdB = `evt_settle_b_${randomUUID()}`;
    const settleBodyB = JSON.stringify({
      id: settleEventIdB,
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { tenant_id: tenantB.tenantId, invoice_id: invoiceB.invoiceId },
          amount_total: invoiceB.totalCents,
          payment_status: 'paid',
          payment_intent: `pi_${settleEventIdB}`,
        },
      },
    });
    const settleResB = await request.post(`${API_URL}/webhooks/stripe`, {
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSignature(settleBodyB, STRIPE_WEBHOOK_SECRET!),
      },
      data: settleBodyB,
    });
    expect(settleResB.ok()).toBeTruthy();
    const paymentRowsB = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantB.tenantId, invoiceB.invoiceId],
    );
    expect(paymentRowsB).toHaveLength(1);

    // ── ONE Stripe refund id, delivered TWICE, concurrently, under TWO
    //    DISTINCT event ids ──────────────────────────────────────────────
    // (the exact race the 8.8 acceptance names: "two concurrent deliveries
    // of one stripe_refund_id"). Distinct event ids so the assertion
    // exercises the INNER (tenant_id, stripe_refund_id) claim in
    // recordRefundIdempotent — not just the outer webhook_events
    // event-id dedup, which a same-id redelivery would short-circuit
    // before ever reaching the refund ledger.
    const stripeRefundId = `re_${randomUUID()}`;
    function refundEventBody(eventId: string): string {
      return JSON.stringify({
        id: eventId,
        type: 'charge.refunded',
        data: {
          object: {
            id: `ch_${randomUUID()}`,
            payment_intent: `pi_${settleEventId}`,
            refunds: {
              data: [
                {
                  id: stripeRefundId,
                  amount: 15_000,
                  status: 'succeeded',
                  metadata: { tenant_id: tenantA.tenantId, payment_id: paymentId },
                },
              ],
            },
          },
        },
      });
    }
    const bodyDelivery1 = refundEventBody(`evt_refund_1_${randomUUID()}`);
    const bodyDelivery2 = refundEventBody(`evt_refund_2_${randomUUID()}`);
    const [refundRes1, refundRes2] = await Promise.all([
      request.post(`${API_URL}/webhooks/stripe`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignature(bodyDelivery1, STRIPE_WEBHOOK_SECRET!),
        },
        data: bodyDelivery1,
      }),
      request.post(`${API_URL}/webhooks/stripe`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignature(bodyDelivery2, STRIPE_WEBHOOK_SECRET!),
        },
        data: bodyDelivery2,
      }),
    ]);
    expect(refundRes1.ok(), `refund delivery 1 -> ${refundRes1.status()} ${await refundRes1.text()}`).toBeTruthy();
    expect(refundRes2.ok(), `refund delivery 2 -> ${refundRes2.status()} ${await refundRes2.text()}`).toBeTruthy();

    // #1133 workaround — the webhook's transaction commits on res.finish,
    // AFTER the 200 is flushed; poll the idempotency-ledger claim row
    // (written in the SAME transaction as the credit) until it lands
    // before reading the payment row on a separate connection.
    await pollRows(
      tenantA.tenantId,
      `SELECT id FROM payment_refunds WHERE tenant_id = $1 AND stripe_refund_id = $2`,
      [tenantA.tenantId, stripeRefundId],
      { minRows: 1, timeoutMs: 10_000 },
    );

    // ── amount_refunded_cents increments EXACTLY ONCE; status never flips ─
    const afterRefund = await queryAsTenant(
      tenantA.tenantId,
      `SELECT amount_cents, refunded_amount_cents, status FROM payments WHERE id = $1 AND tenant_id = $2`,
      [paymentId, tenantA.tenantId],
    );
    expect(afterRefund).toHaveLength(1);
    expect(afterRefund[0].amount_cents).toBe(50_000);
    expect(Number(afterRefund[0].refunded_amount_cents)).toBe(15_000);
    expect(afterRefund[0].status).toBe('completed');

    // ── exactly ONE claim row in the idempotency ledger ───────────────────
    const claimRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT amount_cents FROM payment_refunds WHERE tenant_id = $1 AND stripe_refund_id = $2`,
      [tenantA.tenantId, stripeRefundId],
    );
    expect(claimRows).toHaveLength(1);
    expect(Number(claimRows[0].amount_cents)).toBe(15_000);

    // ── exactly ONE payment.refunded audit event, not two ────────────────
    const auditRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type, metadata FROM audit_events WHERE tenant_id = $1 AND entity_type = 'payment' AND entity_id = $2 AND event_type = 'payment.refunded'`,
      [tenantA.tenantId, paymentId],
    );
    expect(auditRows).toHaveLength(1);

    // ── T2: neighbour tenant's claim ledger and audit trail are untouched ─
    const neighbourClaims = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM payment_refunds WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(neighbourClaims).toHaveLength(0);
    const neighbourAudit = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM audit_events WHERE tenant_id = $1 AND event_type = 'payment.refunded'`,
      [tenantB.tenantId],
    );
    expect(neighbourAudit).toHaveLength(0);
    const neighbourPayment = await queryAsTenant(
      tenantB.tenantId,
      `SELECT refunded_amount_cents FROM payments WHERE tenant_id = $1 AND id = $2`,
      [tenantB.tenantId, paymentRowsB[0].id as string],
    );
    expect(Number(neighbourPayment[0].refunded_amount_cents)).toBe(0);
  });
});
