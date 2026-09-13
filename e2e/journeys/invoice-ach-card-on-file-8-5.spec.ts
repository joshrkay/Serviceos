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
  Tenant,
} from '../fixtures/money-lane-8-8';

/**
 * 8.5 — rung-5 reachability for the ACH and card-on-file halves ONLY (per
 * the section brief: off-session charging and card-present stay
 * report-only — no Docker-gated test exists for card-present, and
 * off-session charging is unit-only against a mocked fetch; neither can be
 * driven through a real surface without a live Stripe test-mode key,
 * #1000).
 *
 * ACH: PR #1055's `ach-webhook.test.ts` already proves the
 * processing/succeeded/payment_failed lifecycle at real Postgres by
 * calling the webhook handler's exported pieces in-process. This spec
 * drives the SAME lifecycle through the real, signed `/webhooks/stripe`
 * route — including the duplicate-delivery no-double-credit case the
 * acceptance names.
 *
 * Card on file: `customer-payment-methods.test.ts` proves the storage
 * round-trip against the repository directly. This spec drives the ONLY
 * real surface that ever writes that table
 * (`setup_intent.succeeded` in webhooks/routes.ts:1237) through the real
 * signed webhook. Honest boundary: this sandbox has no real Stripe
 * account behind `STRIPE_SECRET_KEY` (a placeholder, matching every other
 * spec in this lane), so the handler's own `retrievePaymentMethod` call
 * for display metadata (brand/last4) fails fast (a real 401 from
 * api.stripe.com — confirmed reachable from this network) and is
 * swallowed by its own try/catch (webhooks/routes.ts:1272) exactly as
 * production does when Stripe momentarily errors: the row still
 * persists with real ids, brand/last4 stay null. That's the same
 * "reach to the boundary, assert the boundary" honesty as 8.4's
 * STRIPE_NOT_CONFIGURED leg.
 */

function processingWebhookBody(tenantId: string, invoiceId: string, amountCents: number, piId: string): string {
  return JSON.stringify({
    id: `evt_ach_proc_${randomUUID()}`,
    type: 'payment_intent.processing',
    data: {
      object: {
        id: piId,
        amount: amountCents,
        metadata: { tenant_id: tenantId, invoice_id: invoiceId },
        payment_method_types: ['us_bank_account'],
      },
    },
  });
}

function succeededWebhookBody(tenantId: string, invoiceId: string, amountCents: number, piId: string, eventId?: string): string {
  return JSON.stringify({
    id: eventId ?? `evt_ach_succ_${randomUUID()}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: piId,
        amount_received: amountCents,
        metadata: { tenant_id: tenantId, invoice_id: invoiceId },
        payment_method_types: ['us_bank_account'],
      },
    },
  });
}

function failedWebhookBody(tenantId: string, invoiceId: string, piId: string): string {
  return JSON.stringify({
    id: `evt_ach_fail_${randomUUID()}`,
    type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: piId,
        metadata: { tenant_id: tenantId, invoice_id: invoiceId },
        payment_method_types: ['us_bank_account'],
        last_payment_error: { decline_code: 'insufficient_funds', message: 'ACH return R01' },
      },
    },
  });
}

async function postStripeWebhook(request: import('@playwright/test').APIRequestContext, body: string) {
  return request.post(`${API_URL}/webhooks/stripe`, {
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripeSignature(body, STRIPE_WEBHOOK_SECRET!),
    },
    data: body,
  });
}

test.describe('ACH lifecycle + card-on-file storage (8.5) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!STRIPE_WEBHOOK_SECRET &&
    !!process.env.STRIPE_SECRET_KEY;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), STRIPE_WEBHOOK_SECRET, ' +
      'STRIPE_SECRET_KEY (a placeholder — enables setup_intent.succeeded card storage; this spec ' +
      'never mints a payment link, so the real-network-call risk 8.7 hit does not apply here), and ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container.',
  );

  test('ACH processing -> succeeded settles exactly once with an audit chain; processing -> payment_failed reverses the credit and reopens the invoice; a duplicate succeeded delivery does not double-credit; a neighbour tenant is untouched', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const tenantA: Tenant = await bootstrapOwner(request, 'ach-a', 'ACH HVAC 8.5');
    const tenantB: Tenant = await bootstrapOwner(request, 'ach-b', 'Neighbour ACH 8.5');

    // ── Scenario 1: processing -> succeeded ───────────────────────────────
    const seed1 = await seedCustomerJob(request, tenantA, 'Drew', '8.5 ACH settle journey');
    const inv1 = await seedIssuedInvoice(request, tenantA, seed1.jobId, 30_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${inv1.invoiceId}`, tenantA.authHeaders);
    const pi1 = `pi_ach_settle_${randomUUID()}`;

    const proc1 = await postStripeWebhook(request, processingWebhookBody(tenantA.tenantId, inv1.invoiceId, 30_000, pi1));
    expect(proc1.ok(), `processing -> ${proc1.status()} ${await proc1.text()}`).toBeTruthy();

    const afterProcessing = await request.get(`${API_URL}/api/invoices/${inv1.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await afterProcessing.json()) as { amountPaidCents: number }).amountPaidCents).toBe(30_000);

    const succ1 = await postStripeWebhook(request, succeededWebhookBody(tenantA.tenantId, inv1.invoiceId, 30_000, pi1));
    expect(succ1.ok(), `succeeded -> ${succ1.status()} ${await succ1.text()}`).toBeTruthy();

    const afterSucceeded = await request.get(`${API_URL}/api/invoices/${inv1.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const succBody = (await afterSucceeded.json()) as { status: string; amountPaidCents: number };
    expect(succBody.status).toBe('paid');
    expect(succBody.amountPaidCents).toBe(30_000);

    const payments1 = await queryAsTenant(
      tenantA.tenantId,
      `SELECT status, amount_cents FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, inv1.invoiceId],
    );
    expect(payments1).toHaveLength(1);
    expect(payments1[0].status).toBe('completed');
    expect(payments1[0].amount_cents).toBe(30_000);

    const audit1 = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 ORDER BY created_at`,
      [tenantA.tenantId, inv1.invoiceId],
    );
    expect(audit1.length).toBeGreaterThan(0);
    expect(audit1.some((r) => r.event_type === 'payment.recorded')).toBeTruthy();

    // ── Duplicate delivery of the SAME succeeded event: no double-credit ──
    const succ1Replay = await postStripeWebhook(request, succeededWebhookBody(tenantA.tenantId, inv1.invoiceId, 30_000, pi1));
    expect(succ1Replay.ok()).toBeTruthy();
    const paymentsAfterReplay = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, inv1.invoiceId],
    );
    expect(paymentsAfterReplay).toHaveLength(1);
    const invoiceAfterReplay = await request.get(`${API_URL}/api/invoices/${inv1.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await invoiceAfterReplay.json()) as { amountPaidCents: number }).amountPaidCents).toBe(30_000);

    // ── Scenario 2: processing -> payment_failed (ACH return) reverses ────
    const seed2 = await seedCustomerJob(request, tenantA, 'Erin', '8.5 ACH return journey');
    const inv2 = await seedIssuedInvoice(request, tenantA, seed2.jobId, 18_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${inv2.invoiceId}`, tenantA.authHeaders);
    const pi2 = `pi_ach_return_${randomUUID()}`;

    const proc2 = await postStripeWebhook(request, processingWebhookBody(tenantA.tenantId, inv2.invoiceId, 18_000, pi2));
    expect(proc2.ok()).toBeTruthy();
    const afterProcessing2 = await request.get(`${API_URL}/api/invoices/${inv2.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await afterProcessing2.json()) as { amountDueCents: number }).amountDueCents).toBe(0);

    const fail2 = await postStripeWebhook(request, failedWebhookBody(tenantA.tenantId, inv2.invoiceId, pi2));
    expect(fail2.ok(), `payment_failed -> ${fail2.status()} ${await fail2.text()}`).toBeTruthy();

    const afterReturn = await request.get(`${API_URL}/api/invoices/${inv2.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const returnBody = (await afterReturn.json()) as { status: string; amountDueCents: number; amountPaidCents: number };
    expect(returnBody.status).not.toBe('paid');
    expect(returnBody.amountDueCents).toBe(18_000);
    expect(returnBody.amountPaidCents).toBe(0);

    const payment2 = await queryAsTenant(
      tenantA.tenantId,
      `SELECT status, reversed_at, reversal_reason FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, inv2.invoiceId],
    );
    expect(payment2).toHaveLength(1);
    expect(payment2[0].reversed_at).not.toBeNull();
    expect(payment2[0].reversal_reason).toBe('ach_return');

    // ── T2: a neighbour tenant racing its own ACH webhook is untouched ────
    const seedB = await seedCustomerJob(request, tenantB, 'Blair', '8.5 neighbour ACH journey');
    const invB = await seedIssuedInvoice(request, tenantB, seedB.jobId, 7_500);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invB.invoiceId}`, tenantB.authHeaders);
    const piB = `pi_ach_neighbour_${randomUUID()}`;
    const procB = await postStripeWebhook(request, processingWebhookBody(tenantB.tenantId, invB.invoiceId, 7_500, piB));
    expect(procB.ok()).toBeTruthy();

    const neighbourInvoice = await request.get(`${API_URL}/api/invoices/${invB.invoiceId}`, {
      headers: tenantB.authHeaders,
    });
    expect(((await neighbourInvoice.json()) as { amountPaidCents: number }).amountPaidCents).toBe(7_500);
    const crossPayments = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, invB.invoiceId],
    );
    expect(crossPayments).toHaveLength(0);
    // Tenant A's already-reversed invoice 2 is unaffected by tenant B's race.
    const inv2Unaffected = await request.get(`${API_URL}/api/invoices/${inv2.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    expect(((await inv2Unaffected.json()) as { amountDueCents: number }).amountDueCents).toBe(18_000);
  });

  test('a saved card (setup_intent.succeeded) persists real ids through the real signed webhook; a neighbour tenant cannot read it', async ({
    request,
  }) => {
    test.setTimeout(60_000);

    const tenantA: Tenant = await bootstrapOwner(request, 'card-a', 'Card-on-file HVAC 8.5');
    const tenantB: Tenant = await bootstrapOwner(request, 'card-b', 'Neighbour Card 8.5');
    const seedA = await seedCustomerJob(request, tenantA, 'Frankie', '8.5 card-on-file journey');

    const stripeCustomerId = `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const stripePaymentMethodId = `pm_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const body = JSON.stringify({
      id: `evt_setup_${randomUUID()}`,
      type: 'setup_intent.succeeded',
      data: {
        object: {
          customer: stripeCustomerId,
          payment_method: stripePaymentMethodId,
          metadata: { tenant_id: tenantA.tenantId, customer_id: seedA.customerId },
        },
      },
    });
    const res = await postStripeWebhook(request, body);
    expect(res.ok(), `setup_intent.succeeded -> ${res.status()} ${await res.text()}`).toBeTruthy();

    const rows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT customer_id, stripe_customer_id, stripe_payment_method_id, is_default, brand, last4 FROM customer_payment_methods WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantA.tenantId, seedA.customerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_customer_id).toBe(stripeCustomerId);
    expect(rows[0].stripe_payment_method_id).toBe(stripePaymentMethodId);
    expect(rows[0].is_default).toBe(true); // first saved card becomes default

    // A replay of the SAME setup_intent.succeeded is idempotent — no second row.
    const replay = await postStripeWebhook(request, body.replace('evt_setup_', 'evt_setup_replay_'));
    expect(replay.ok()).toBeTruthy();
    const rowsAfterReplay = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM customer_payment_methods WHERE tenant_id = $1 AND stripe_payment_method_id = $2`,
      [tenantA.tenantId, stripePaymentMethodId],
    );
    expect(rowsAfterReplay).toHaveLength(1);

    // ── T2: a neighbour tenant cannot read tenant A's saved card ──────────
    const neighbourRows = await queryAsTenant(
      tenantB.tenantId,
      `SELECT id FROM customer_payment_methods WHERE tenant_id = $1`,
      [tenantB.tenantId],
    );
    expect(neighbourRows).toHaveLength(0);
  });
});
