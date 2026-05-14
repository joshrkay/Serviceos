import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import * as crypto from 'node:crypto';

/**
 * INV-01..INV-07 — 4-agent swarm. See estimates.spec.ts for the pattern.
 *
 * Several rows are pre-run expected to FAIL against the current codebase
 * (INV-02, INV-04, INV-05, INV-07) because the features are not wired end
 * to end. The swarm still runs them so the failure mode is captured as
 * evidence — that output becomes the backlog in QA-REPORT.md.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('INV-01', 'Create invoice', async (h) => {
  const apiResp = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '01-create',
    expectStatus: 201,
  });
  const id = (apiResp.response.body as { id: string }).id;

  const db = await h.db.query({
    label: '01-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, tenant_id, status, invoice_number, total_cents FROM invoices WHERE id = $1`,
    params: [id],
  });
  expect(db.rowCount).toBe(1);
  expect((db.rows[0] as { status: string }).status).toBe('draft');

  await gotoUi(h, `/invoices/${id}`, '01-detail');
  h.evidence.pass();
});

matrixTest('INV-02', 'List/filter invoices', async (h) => {
  // Expect 404/405 — endpoint is not implemented.
  const apiResp = await h.api.call({
    method: 'GET',
    path: '/api/invoices?status=draft',
    token: h.tenantA.token,
    label: '02-list',
  });

  if (apiResp.response.status === 200) {
    const db = await h.db.query({
      label: '02-db-counts',
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status, count(*)::int AS n FROM invoices WHERE tenant_id = $1 GROUP BY status`,
      params: [h.tenantA.tenantId],
    });
    h.evidence.note(`API 200 and DB counts captured. Row flipped to pass — verify UI separately.`);
    await gotoUi(h, '/invoices?status=draft', '02-list-ui');
    h.evidence.pass(`Counts by status: ${JSON.stringify(db.rows)}`);
    return;
  }

  await gotoUi(h, '/invoices', '02-list-ui');
  h.evidence.fail(
    `GET /api/invoices returned ${apiResp.response.status}. No list endpoint implemented; UI has filter controls but no backend to serve them.`
  );
});

matrixTest('INV-03', 'Send invoice', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '03-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;

  const issued = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '03-issue',
    expectStatus: [200, 201],
  });
  const body = issued.response.body as { status?: string; issuedAt?: string };
  expect(body.status).toBe('open');
  expect(body.issuedAt).toBeTruthy();

  const db = await h.db.query({
    label: '03-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status, issued_at, due_date FROM invoices WHERE id = $1`,
    params: [id],
  });
  const row = db.rows[0] as { status: string; issued_at: string };
  expect(row.status).toBe('open');
  expect(row.issued_at).toBeTruthy();

  await gotoUi(h, `/invoices/${id}`, '03-detail');
  h.evidence.partial("Matches implementation: status 'open' + issued_at. Matrix 'sent' / sent_at terminology does not match product schema. No email/SMS delivery.");
});

matrixTest('INV-04', 'Payment link generation', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '04-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;

  // Try common shapes — all expected to 404.
  const candidates: Array<{ method: 'POST' | 'GET'; path: string }> = [
    { method: 'POST', path: `/api/invoices/${id}/payment-link` },
    { method: 'GET', path: `/api/invoices/${id}/payment-link` },
    { method: 'POST', path: `/api/payments/link` },
  ];

  let found = false;
  for (const c of candidates) {
    const resp = await h.api.call({
      method: c.method,
      path: c.path,
      body: c.method === 'POST' ? { invoiceId: id } : undefined,
      token: h.tenantA.token,
      label: `04-${c.method.toLowerCase()}-${c.path.replace(/[^a-z0-9]+/gi, '-')}`,
    });
    if (resp.response.status === 200 || resp.response.status === 201) {
      found = true;
      break;
    }
  }

  await gotoUi(h, `/invoices/${id}`, '04-detail');
  if (found) {
    h.evidence.pass('Payment link endpoint responded successfully.');
  } else {
    h.evidence.fail('No payment-link HTTP endpoint responded. StripePaymentLinkProvider is implemented but not mounted on a route.');
  }
});

matrixTest('INV-05', 'Mark paid via webhook', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '05-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '05-issue',
    expectStatus: [200, 201, 404],
  });

  // The /webhooks/stripe route is mounted and signature-gated. To exercise
  // it end to end the harness must sign with the same secret the API uses;
  // without E2E_STRIPE_WEBHOOK_SECRET we can only confirm the route exists.
  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    await gotoUi(h, `/invoices/${id}`, '05-detail');
    h.evidence.partial(
      'POST /webhooks/stripe is mounted and signature-gated. Set E2E_STRIPE_WEBHOOK_SECRET ' +
        '(matching the API STRIPE_WEBHOOK_SECRET) to exercise the payment path end to end.'
    );
    return;
  }

  const event = buildStripeCheckoutEvent({
    tenantId: h.tenantA.tenantId,
    invoiceId: id,
    amountCents: 20000,
  });
  const resp = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: event,
    label: '05-webhook',
    headers: { 'stripe-signature': signStripeWebhook(JSON.stringify(event), secret) },
    expectStatus: 200,
  });

  const db = await h.db.query({
    label: '05-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status, amount_paid_cents FROM invoices WHERE id = $1`,
    params: [id],
  });
  const row = db.rows[0] as { status: string; amount_paid_cents: number };

  await gotoUi(h, `/invoices/${id}`, '05-detail');

  if (row.status === 'paid') {
    h.evidence.pass(
      `Signed checkout.session.completed marked the invoice paid (amount_paid=${row.amount_paid_cents}).`
    );
  } else {
    h.evidence.fail(
      `Webhook accepted (${resp.response.status}) but invoice status is '${row.status}', amount_paid=${row.amount_paid_cents}.`
    );
  }
});

matrixTest('INV-06', 'Idempotent payment handling', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '06-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '06-issue',
    expectStatus: [200, 201, 404],
  });

  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    await gotoUi(h, `/invoices/${id}`, '06-detail');
    h.evidence.partial(
      'POST /webhooks/stripe is mounted with DB-backed idempotency. Set E2E_STRIPE_WEBHOOK_SECRET ' +
        'to exercise the duplicate-delivery path end to end.'
    );
    return;
  }

  // Same event id delivered twice — the second must be a no-op (duplicate).
  const event = buildStripeCheckoutEvent({
    tenantId: h.tenantA.tenantId,
    invoiceId: id,
    amountCents: 20000,
  });
  const sig = signStripeWebhook(JSON.stringify(event), secret);
  const first = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: event,
    label: '06-webhook-first',
    headers: { 'stripe-signature': sig },
    expectStatus: 200,
  });
  const second = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: event,
    label: '06-webhook-second',
    headers: { 'stripe-signature': sig },
    expectStatus: 200,
  });

  const db = await h.db.query({
    label: '06-payments',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM payments WHERE invoice_id = $1`,
    params: [id],
  });
  const count = (db.rows[0] as { c: number }).c;
  const secondDup = (second.response.body as { duplicate?: boolean }).duplicate === true;

  await gotoUi(h, `/invoices/${id}`, '06-detail');

  if (count <= 1 && secondDup) {
    h.evidence.pass(
      `Duplicate webhook was a no-op (payments rows: ${count}; second delivery flagged duplicate).`
    );
  } else {
    h.evidence.fail(
      `first=${first.response.status}, second=${second.response.status} (duplicate=${secondDup}), ` +
        `payments rows=${count}.`
    );
  }
});

matrixTest('INV-07', 'Overdue lifecycle', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '07-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;

  // Try to transition directly to 'overdue' — expect 400 since enum doesn't include it.
  const overdueAttempt = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/transition`,
    body: { status: 'overdue' },
    token: h.tenantA.token,
    label: '07-transition-overdue',
    expectStatus: [200, 400],
  });

  // `invoices.status` is a text column with a CHECK constraint, not a pg
  // enum — enum_range() does not apply. Just check whether any 'overdue'
  // invoice actually exists, which is what the verdict logic below needs.
  const db = await h.db.query({
    label: '07-check-overdue',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id FROM invoices WHERE tenant_id = $1 AND status = 'overdue' LIMIT 1`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, `/invoices/${id}`, '07-detail');

  if (overdueAttempt.response.status === 200 && db.rowCount > 0) {
    h.evidence.pass('Overdue transition accepted and rows exist.');
  } else {
    h.evidence.fail(
      "No 'overdue' status in the invoices schema; no cron/on-read logic to transition past-due invoices. Feature is not implemented."
    );
  }
});

// ---------------- helpers ----------------

async function gotoUi(h: RowHarness, path: string, label: string): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL!;
  try {
    await h.page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    h.evidence.note(`navigation to ${path} failed: ${(err as Error).message}`);
  }
  await h.snapshot(`${label}-before`);
  await h.page.waitForTimeout(500);
  await h.snapshot(`${label}-after`);
}

function buildMinimalInvoicePayload(jobId: string) {
  return {
    jobId,
    lineItems: [
      {
        id: `li-${Date.now()}`,
        description: 'Service fee',
        quantity: 1,
        unitPriceCents: 20000,
        totalCents: 20000,
        sortOrder: 0,
        taxable: true,
        category: 'labor',
      },
    ],
    discountCents: 0,
    taxRateBps: 0,
  };
}

/**
 * Build a `checkout.session.completed` event in the exact shape the API's
 * /webhooks/stripe handler consumes: snake_case metadata (`tenant_id`,
 * `invoice_id`), `payment_status: 'paid'`, and `amount_total` in cents.
 * (The previous fixture sent `payment_intent.succeeded` with camelCase
 * `invoiceId` — an event shape the handler never processes.)
 */
function buildStripeCheckoutEvent(opts: {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
}) {
  const ts = Math.floor(Date.now() / 1000);
  return {
    id: `evt_qa_${Date.now()}`,
    type: 'checkout.session.completed',
    created: ts,
    data: {
      object: {
        id: `cs_qa_${Date.now()}`,
        payment_status: 'paid',
        amount_total: opts.amountCents,
        currency: 'usd',
        metadata: {
          tenant_id: opts.tenantId,
          invoice_id: opts.invoiceId,
        },
      },
    },
  };
}

/**
 * Stripe-style webhook signature: `t=<ts>,v1=HMAC-SHA256(secret, "<ts>.<rawBody>")`.
 * `rawBody` must be the exact string the request sends — ApiVerifier
 * re-serialises with JSON.stringify, so sign over JSON.stringify(event).
 */
function signStripeWebhook(rawBody: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
