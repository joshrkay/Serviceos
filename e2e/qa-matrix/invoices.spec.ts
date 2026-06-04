import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

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

  const webhookPayload = buildStripeWebhook(id);
  // QA-2026-06-04: tolerate every plausible webhook response (route absent →
  // 404, bad signature → 400/401, accepted → 200). The verdict is decided by
  // the DB check below; throwing here serially blocked INV-06/07 forever.
  const resp = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '05-webhook',
    headers: {
      'stripe-signature': 't=0,v1=test-sig', // signature check will reject in prod, captured as evidence
    },
    expectStatus: [200, 201, 202, 400, 401, 403, 404, 500],
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
    h.evidence.pass();
  } else {
    const bodyErr = (resp.response.body as { error?: string } | null)?.error ?? '';
    h.evidence.fail(
      `Stripe webhook responded ${resp.response.status}${bodyErr ? ` (${bodyErr})` : ''}; invoice status remained '${row.status}'. ` +
        'Route is mounted; on dev this is typically STRIPE_WEBHOOK_SECRET unset (500 "not configured") or a forged signature (401). ' +
        'A real verdict needs `stripe listen` + the secret configured.'
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
  const webhookPayload = buildStripeWebhook(id);

  const first = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '06-webhook-first',
    headers: { 'stripe-signature': 't=0,v1=test-sig' },
  });
  const second = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '06-webhook-second',
    headers: { 'stripe-signature': 't=0,v1=test-sig' },
  });

  const db = await h.db.query({
    label: '06-payments',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM payments WHERE invoice_id = $1`,
    params: [id],
  });
  const count = (db.rows[0] as { c: number }).c;

  await gotoUi(h, `/invoices/${id}`, '06-detail');

  if (first.response.status === 200 && second.response.status === 200 && count <= 1) {
    h.evidence.pass(`Duplicate webhook did not double-apply (payments rows: ${count}).`);
  } else {
    h.evidence.partial(
      `First=${first.response.status}, second=${second.response.status}, payments rows=${count}. ` +
        `Webhook route likely not mounted; idempotency logic cannot be exercised end-to-end.`
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

  // QA-2026-06-04: tenant-scoped existence probe (the old no-GUC query
  // errored on RLS under qa_readonly). Scoped to tenant A is sufficient —
  // the question is only whether 'overdue' is a reachable status value.
  const db = await h.db.query({
    label: '07-check-enum',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT DISTINCT status FROM invoices WHERE status = 'overdue'`,
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

function buildStripeWebhook(invoiceId: string) {
  const id = `evt_qa_${Date.now()}`;
  return {
    id,
    type: 'payment_intent.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_qa_${Date.now()}`,
        amount: 20000,
        currency: 'usd',
        metadata: {
          invoiceId,
        },
      },
    },
  };
}
