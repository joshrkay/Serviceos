import * as crypto from 'node:crypto';
import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { seedFreshJob } from './helpers/seed-entities';
import { rwAvailable, rwExec } from './helpers/rw-db';

/**
 * INV-01..INV-07 — 4-agent swarm. See estimates.spec.ts for the pattern.
 *
 * Several rows are pre-run expected to FAIL against the current codebase
 * (INV-02, INV-04, INV-05, INV-07) because the features are not wired end
 * to end. The swarm still runs them so the failure mode is captured as
 * evidence — that output becomes the backlog in QA-REPORT.md.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('INV-CR-01', 'Create invoice', async (h) => {
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

matrixTest('INV-CR-02', 'List/filter invoices', async (h) => {
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
  // QA-2026-06-05: exercise the REAL delivery leg. The old spec stopped at
  // issue and hardcoded partial ('no email/SMS delivery') — but dev runs the
  // InMemoryDeliveryProvider; delivery only ever failed because the shared
  // fixture customer had no consent/email. Own consenting customer + job.
  const { jobId } = await seedFreshJob(h, '03-seed', h.tenantA, { smsConsent: true, email: 'qa.inv03@example.com' });
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(jobId),
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

  const send = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/send`,
    body: { channel: 'sms' },
    token: h.tenantA.token,
    label: '03-send',
    expectStatus: [200, 202],
  });
  const sendBody = send.response.body as { channelsSent?: Array<{ channel?: string }> };

  const db = await h.db.query({
    label: '03-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status, issued_at, view_token FROM invoices WHERE id = $1`,
    params: [id],
  });
  const row = db.rows[0] as { status: string; issued_at: string; view_token: string | null };
  expect(row.status).toBe('open');
  expect(row.issued_at).toBeTruthy();

  const dispatches = await h.db.query({
    label: '03-dispatches',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT entity_type, channel, status FROM message_dispatches WHERE entity_id = $1`,
    params: [id],
  });

  await gotoUi(h, `/invoices/${id}`, '03-detail');
  if ((sendBody.channelsSent?.length ?? 0) > 0 && row.view_token) {
    h.evidence.pass(
      `Issued (open + issued_at) and delivered via ${sendBody.channelsSent!.map((c) => c.channel).join(',')}; ` +
        `view token minted; dispatch rows: ${dispatches.rowCount}.`
    );
  } else {
    h.evidence.partial(
      `Issued ok; send=${send.response.status}, channelsSent=${sendBody.channelsSent?.length ?? 0}, ` +
        `view_token=${row.view_token ? 'minted' : 'absent'}, dispatch rows=${dispatches.rowCount}.`
    );
  }
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

  // QA-2026-06-05: POST /api/invoices/:id/payment-link is mounted now (the
  // old spec predates it and probed dead paths against a DRAFT invoice).
  // Contract per INV-04 story: only open/partially_paid are payable (409
  // otherwise), response carries { url, expiresAt }.

  // Negative: payment link on a draft must be refused with a typed 409.
  const draftAttempt = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/payment-link`,
    body: {},
    token: h.tenantA.token,
    label: '04-draft-refused',
    expectStatus: [400, 409],
  });

  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '04-issue',
    expectStatus: [200, 201],
  });

  const link = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/payment-link`,
    body: {},
    token: h.tenantA.token,
    label: '04-payment-link',
    expectStatus: [200, 201],
  });
  const body = link.response.body as { url?: string; expiresAt?: string | null };

  await gotoUi(h, `/invoices/${id}`, '04-detail');
  if (typeof body.url === 'string' && body.url.startsWith('https://checkout.stripe.com')) {
    h.evidence.pass(`Hosted Stripe checkout link minted; draft correctly refused (${draftAttempt.response.status}).`);
  } else if (typeof body.url === 'string' && body.url.length > 0) {
    h.evidence.pass(
      `Payment-link endpoint works end-to-end (draft refused ${draftAttempt.response.status}); dev uses the mock provider ` +
        `(no STRIPE_SECRET_KEY) so the URL is synthetic: ${body.url.slice(0, 60)}`
    );
  } else {
    h.evidence.fail(`payment-link returned ${link.response.status} without a url. Body: ${JSON.stringify(link.response.body).slice(0, 150)}`);
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

  const issued = await h.api.call({
    method: 'GET',
    path: `/api/invoices/${id}`,
    token: h.tenantA.token,
    label: '05-issued',
    expectStatus: 200,
  });
  const totalCents = (issued.response.body as { totals?: { totalCents?: number }; totalCents?: number }).totals?.totalCents
    ?? (issued.response.body as { totalCents?: number }).totalCents
    ?? 20000;

  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET;
  const webhookPayload = buildStripeWebhook(h.tenantA.tenantId, id, totalCents);
  // With a shared dev secret we sign exactly like Stripe and exercise the
  // real verification + payment application path. Without it (other envs),
  // the forged signature documents the 401 and the row degrades gracefully.
  const resp = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '05-webhook',
    headers: {
      'stripe-signature': secret
        ? signStripeWebhook(webhookPayload, secret)
        : 't=0,v1=test-sig',
    },
    expectStatus: [200, 201, 202, 400, 401, 403, 404, 500],
  });

  // Payment application is synchronous in the route, but poll briefly for
  // rollup writes.
  let row: { status: string; amount_paid_cents: number } | undefined;
  for (let i = 0; i < 5; i++) {
    const db = await h.db.query({
      label: i === 0 ? '05-row' : `05-row-poll${i}`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status, amount_paid_cents FROM invoices WHERE id = $1`,
      params: [id],
    });
    row = db.rows[0] as { status: string; amount_paid_cents: number };
    if (row?.status === 'paid') break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  await gotoUi(h, `/invoices/${id}`, '05-detail');

  if (row?.status === 'paid') {
    h.evidence.pass(`Signed checkout.session.completed marked the invoice paid (amount_paid_cents=${row.amount_paid_cents}).`);
  } else if (!secret) {
    h.evidence.partial(
      `E2E_STRIPE_WEBHOOK_SECRET not set — forged signature correctly rejected (${resp.response.status}); ` +
        'payment application not exercised. Set the shared dev secret to run this row fully.'
    );
  } else {
    const bodyErr = (resp.response.body as { error?: string } | null)?.error ?? '';
    h.evidence.fail(
      `Signed webhook responded ${resp.response.status}${bodyErr ? ` (${bodyErr})` : ''}; invoice stayed '${row?.status}'. ` +
        'Check STRIPE_WEBHOOK_SECRET matches E2E_STRIPE_WEBHOOK_SECRET on the deployed API.'
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
    expectStatus: [200, 201],
  });

  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET;
  // SAME event id on both deliveries — that's what the dedup keys on.
  const webhookPayload = buildStripeWebhook(h.tenantA.tenantId, id, 20000, `evt_qa_dup_${Date.now()}`);
  const sig = () => (secret ? signStripeWebhook(webhookPayload, secret) : 't=0,v1=test-sig');

  const first = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '06-webhook-first',
    headers: { 'stripe-signature': sig() },
    expectStatus: [200, 401, 500],
  });
  const second = await h.api.call({
    method: 'POST',
    path: '/webhooks/stripe',
    body: webhookPayload,
    label: '06-webhook-second',
    headers: { 'stripe-signature': sig() },
    expectStatus: [200, 401, 500],
  });

  const db = await h.db.query({
    label: '06-payments',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM payments WHERE invoice_id = $1`,
    params: [id],
  });
  const count = (db.rows[0] as { c: number }).c;
  const duplicateFlag = (second.response.body as { duplicate?: boolean } | null)?.duplicate === true;

  await gotoUi(h, `/invoices/${id}`, '06-detail');

  if (secret && first.response.status === 200 && second.response.status === 200 && duplicateFlag && count === 1) {
    h.evidence.pass(`Duplicate delivery deduped (second returned duplicate:true); exactly one payment row.`);
  } else if (!secret) {
    h.evidence.partial('E2E_STRIPE_WEBHOOK_SECRET not set — idempotency not exercised end-to-end (forged signature rejected).');
  } else {
    h.evidence.fail(
      `First=${first.response.status}, second=${second.response.status}, duplicate=${duplicateFlag}, payments rows=${count}.`
    );
  }
});

matrixTest('INV-07', 'Overdue lifecycle', async (h) => {
  // QA-2026-06-05: aligned with the actual data model — invoices have no
  // 'overdue' STATUS; the hourly sweep (overdue-invoice-worker, env-tunable
  // via OVERDUE_SWEEP_INTERVAL_MS) drives the linked JOB's money_state to
  // 'overdue' and emits an invoice.overdue audit event on the transition.
  if (!rwAvailable()) {
    h.evidence.na('E2E_DB_URL_READWRITE not set — cannot backdate due_date.');
    return;
  }
  const { jobId } = await seedFreshJob(h, '07-seed');
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildMinimalInvoicePayload(jobId),
    token: h.tenantA.token,
    label: '07-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '07-issue',
    expectStatus: [200, 201],
  });
  await rwExec(
    h.tenantA.tenantId,
    `UPDATE invoices SET due_date = now() - interval '5 days' WHERE id = $1`,
    [id]
  );

  let moneyState = 'unknown';
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await h.db.query({
      label: `07-money-state-${i}`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT money_state FROM jobs WHERE id = $1`,
      params: [jobId],
    });
    moneyState = (res.rows[0] as { money_state?: string })?.money_state ?? 'unknown';
    if (moneyState === 'overdue') break;
  }

  const audit = await h.db.query({
    label: '07-audit',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM audit_events WHERE event_type = 'invoice.overdue' AND entity_id = $1`,
    params: [id],
  });
  const auditCount = (audit.rows[0] as { c: number }).c;

  await gotoUi(h, `/invoices/${id}`, '07-detail');
  if (moneyState === 'overdue' && auditCount >= 1) {
    h.evidence.pass(`Sweep drove job money_state=overdue and emitted invoice.overdue audit (${auditCount}).`);
  } else if (moneyState === 'overdue') {
    h.evidence.partial(`money_state=overdue but no invoice.overdue audit row found.`);
  } else {
    h.evidence.partial(`money_state=${moneyState}, audit rows=${auditCount} — sweep did not observe the invoice in the window.`);
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

// QA-2026-06-05: the route handles `checkout.session.completed` with
// payment_status='paid' + metadata {tenant_id, invoice_id} + amount_total
// (the old payment_intent.succeeded shape was silently ignored). With
// E2E_STRIPE_WEBHOOK_SECRET matching the API's STRIPE_WEBHOOK_SECRET we can
// sign exactly like Stripe (t=<unix>,v1=hex(hmac_sha256("{t}.{raw}"))) and
// exercise our verification + payment application + idempotency for real.
function buildStripeWebhook(tenantId: string, invoiceId: string, amountCents: number, eventId?: string) {
  return {
    id: eventId ?? `evt_qa_${Date.now()}`,
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_qa_${Date.now()}`,
        payment_status: 'paid',
        amount_total: amountCents,
        payment_intent: `pi_qa_${Date.now()}`,
        metadata: { tenant_id: tenantId, invoice_id: invoiceId },
      },
    },
  };
}

function signStripeWebhook(payload: unknown, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}
