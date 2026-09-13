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
  Tenant,
} from '../fixtures/money-lane-8-8';

/**
 * 8.6 — rung-5 reachability: "two payments arriving at once both count, so
 * my balance is never wrong". PR #1055's three-file vitest cluster
 * (payment-concurrent-credit / payment-duplicate-race /
 * payment-reversal-concurrent) already proves this at real Postgres by
 * racing `recordPayment` / `recordProcessingPayment` calls directly,
 * in-process. This spec drives the SAME races through the real surfaces:
 * a real owner-authenticated `POST /api/payments` (cash) racing a real
 * SIGNED Stripe `payment_intent.processing` webhook (ACH in-flight
 * credit) on ONE invoice — and, separately, two real
 * `POST /api/payments` calls racing for the SAME full balance — both
 * fired through the actual running HTTP server, never a direct
 * repository/service call.
 */

const CASH_CENTS = 10_000;
const ACH_CENTS = 15_000;
const TOTAL_CENTS = CASH_CENTS + ACH_CENTS; // 25_000 — exactly covers the invoice

async function payCash(
  request: import('@playwright/test').APIRequestContext,
  tenant: Tenant,
  invoiceId: string,
  amountCents: number,
) {
  return request.post(`${API_URL}/api/payments`, {
    headers: { 'content-type': 'application/json', ...tenant.authHeaders },
    data: JSON.stringify({ invoiceId, amountCents, method: 'cash' }),
  });
}

function achProcessingWebhookBody(tenantId: string, invoiceId: string, amountCents: number, piId: string): string {
  return JSON.stringify({
    id: `evt_ach_${randomUUID()}`,
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

test.describe('two payments racing both count, exactly once each (8.6) — real Postgres', () => {
  const canRun =
    !process.env.E2E_BASE_URL &&
    hasViteClerkKey() &&
    process.env.E2E_USE_TEST_DB === 'true' &&
    !!STRIPE_WEBHOOK_SECRET;
  test.skip(
    !canRun,
    'Requires the local webServer pair against a real Postgres: leave E2E_BASE_URL unset, ' +
      'set VITE_CLERK_PUBLISHABLE_KEY (placeholder ok), STRIPE_WEBHOOK_SECRET, and ' +
      'E2E_USE_TEST_DB=true with DATABASE_URL pointing at the test container.',
  );

  test('a $100 cash entry races a $150 ACH webhook — both credit, no lost update; a neighbour races its own payment in the same instant untouched', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const tenantA = await bootstrapOwner(request, 'a', 'Concurrent HVAC 8.6');
    const seedA = await seedCustomerJob(request, tenantA, 'Casey', '8.6 concurrent-credit journey');
    const invoiceA = await seedIssuedInvoice(request, tenantA, seedA.jobId, TOTAL_CENTS);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceA.invoiceId}`, tenantA.authHeaders);

    const tenantB = await bootstrapOwner(request, 'b', 'Neighbour Plumbing 8.6');
    const seedB = await seedCustomerJob(request, tenantB, 'Morgan', '8.6 neighbour journey');
    const invoiceB = await seedIssuedInvoice(request, tenantB, seedB.jobId, 5_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoiceB.invoiceId}`, tenantB.authHeaders);

    const piId = `pi_ach_${randomUUID()}`;
    const achBody = achProcessingWebhookBody(tenantA.tenantId, invoiceA.invoiceId, ACH_CENTS, piId);

    // Race: A's cash payment, A's ACH webhook, AND B's own unrelated cash
    // payment on B's own invoice — all in the SAME Promise.all instant.
    const [cashRes, achRes, neighbourRes] = await Promise.all([
      payCash(request, tenantA, invoiceA.invoiceId, CASH_CENTS),
      request.post(`${API_URL}/webhooks/stripe`, {
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripeSignature(achBody, STRIPE_WEBHOOK_SECRET!),
        },
        data: achBody,
      }),
      payCash(request, tenantB, invoiceB.invoiceId, 5_000),
    ]);
    expect(cashRes.ok(), `cash -> ${cashRes.status()} ${await cashRes.text()}`).toBeTruthy();
    expect(achRes.ok(), `ach webhook -> ${achRes.status()} ${await achRes.text()}`).toBeTruthy();
    expect(neighbourRes.ok(), `neighbour cash -> ${neighbourRes.status()}`).toBeTruthy();

    // ── Both credited; the invoice is fully paid, no lost update ─────────
    const afterInvoice = await request.get(`${API_URL}/api/invoices/${invoiceA.invoiceId}`, {
      headers: tenantA.authHeaders,
    });
    const afterBody = (await afterInvoice.json()) as {
      status: string;
      amountPaidCents: number;
      amountDueCents: number;
    };
    expect(afterBody.amountPaidCents).toBe(TOTAL_CENTS);
    expect(afterBody.amountDueCents).toBe(0);
    expect(afterBody.status).toBe('paid');

    // #1133 workaround — the request transaction commits on res.finish,
    // AFTER the response is flushed; a direct pg.Client read on a separate
    // connection, fired immediately, can still race the commit under load.
    const paymentRows = await pollRows(
      tenantA.tenantId,
      `SELECT amount_cents, payment_method, status FROM payments WHERE tenant_id = $1 AND invoice_id = $2 ORDER BY amount_cents`,
      [tenantA.tenantId, invoiceA.invoiceId],
      { minRows: 2, timeoutMs: 10_000 },
    );
    expect(paymentRows).toHaveLength(2);
    expect(paymentRows.map((r) => Number(r.amount_cents)).sort((x, y) => x - y)).toEqual([
      CASH_CENTS,
      ACH_CENTS,
    ]);

    // The cash leg (recordPayment) audits 'payment.recorded'; the ACH
    // in-flight credit (recordProcessingPayment) audits 'payment.processing'
    // — different event types for the two settlement paths, both real.
    const auditRows = await queryAsTenant(
      tenantA.tenantId,
      `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_type = 'invoice' AND entity_id = $2 AND event_type IN ('payment.recorded', 'payment.processing')`,
      [tenantA.tenantId, invoiceA.invoiceId],
    );
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((r) => r.event_type).sort()).toEqual(['payment.processing', 'payment.recorded']);

    // ── T2 — the neighbour's own concurrent payment landed only on ITS
    //    OWN invoice, never on tenant A's balance ─────────────────────────
    const neighbourInvoice = await request.get(`${API_URL}/api/invoices/${invoiceB.invoiceId}`, {
      headers: tenantB.authHeaders,
    });
    const neighbourBody = (await neighbourInvoice.json()) as { status: string; amountPaidCents: number };
    expect(neighbourBody.status).toBe('paid');
    expect(neighbourBody.amountPaidCents).toBe(5_000);
    const crossPayments = await queryAsTenant(
      tenantA.tenantId,
      `SELECT id FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenantA.tenantId, invoiceB.invoiceId],
    );
    expect(crossPayments).toHaveLength(0);
  });

  test('two concurrent full-balance payments credit exactly once; the SQL cap rejects a credit that no longer fits', async ({
    request,
  }) => {
    test.setTimeout(120_000);

    const tenant = await bootstrapOwner(request, 'c', 'Race HVAC 8.6');
    const seed = await seedCustomerJob(request, tenant, 'Alex', '8.6 full-balance race journey');
    const invoice = await seedIssuedInvoice(request, tenant, seed.jobId, 20_000);
    await pollUntilOk(request, `${API_URL}/api/invoices/${invoice.invoiceId}`, tenant.authHeaders);

    // Two IDENTICAL full-balance cash payments, fired at the same instant.
    const [res1, res2] = await Promise.all([
      payCash(request, tenant, invoice.invoiceId, 20_000),
      payCash(request, tenant, invoice.invoiceId, 20_000),
    ]);
    const results = [res1, res2];
    const oks = results.filter((r) => r.ok());
    const refused = results.filter((r) => !r.ok());
    expect(oks, 'exactly one of the two racing full-balance payments succeeds').toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect([400, 409, 422]).toContain(refused[0].status());

    const afterInvoice = await request.get(`${API_URL}/api/invoices/${invoice.invoiceId}`, {
      headers: tenant.authHeaders,
    });
    const afterBody = (await afterInvoice.json()) as {
      status: string;
      amountPaidCents: number;
      amountDueCents: number;
    };
    expect(afterBody.status).toBe('paid');
    expect(afterBody.amountPaidCents).toBe(20_000);
    expect(afterBody.amountDueCents).toBe(0);

    // #1133 workaround (see the sibling test's identical comment above).
    const paymentRows = await pollRows(
      tenant.tenantId,
      `SELECT amount_cents FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoice.invoiceId],
      { minRows: 1, timeoutMs: 10_000 },
    );
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0].amount_cents).toBe(20_000);

    // ── The cap: a further $1 credit on the now-fully-paid invoice is
    //    refused, not silently overpaid ────────────────────────────────
    const overpay = await payCash(request, tenant, invoice.invoiceId, 100);
    expect(overpay.ok()).toBeFalsy();
    expect([400, 409, 422]).toContain(overpay.status());

    const finalPaymentRows = await queryAsTenant(
      tenant.tenantId,
      `SELECT amount_cents FROM payments WHERE tenant_id = $1 AND invoice_id = $2`,
      [tenant.tenantId, invoice.invoiceId],
    );
    expect(finalPaymentRows).toHaveLength(1);
    const finalInvoice = await request.get(`${API_URL}/api/invoices/${invoice.invoiceId}`, {
      headers: tenant.authHeaders,
    });
    expect(((await finalInvoice.json()) as { amountPaidCents: number }).amountPaidCents).toBe(20_000);
  });
});
