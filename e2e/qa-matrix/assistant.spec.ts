import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * AST-01..AST-07 — FINAL module, runs after Estimates + Invoices.
 * Validates that the assistant can drive / coordinate prior domain objects.
 *
 * Most rows here are expected-fail against the current codebase:
 *   - AST-01: intent classifier returns 'unknown' for customer creation.
 *   - AST-05: no query-type intents supported.
 *   - AST-07: no multi-step orchestration wired.
 *
 * Each fail is captured as evidence so the report can reference the
 * missing capability directly.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('AST-01', 'Create customer via assistant intent', async (h) => {
  const asked = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat('Create a new customer named John Doe at 555-123-4567.'),
    token: h.tenantA.token,
    label: '01-chat',
    expectStatus: [200, 400],
  });
  const reply = normalizeReply(asked.response.body);
  const proposedCustomer = reply.proposal?.type === 'Duplicate' ? null : reply.proposal;

  // Evidence for DB: confirm no customer named 'John Doe' was auto-created
  const db = await h.db.query({
    label: '01-customer-check',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, display_name FROM customers WHERE tenant_id = $1 AND display_name ILIKE 'John Doe%'`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, '/assistant', '01-chat');

  if (proposedCustomer && reply.content.toLowerCase().includes('customer')) {
    h.evidence.partial('Assistant replied about customer creation but no proposal type for create_customer is exposed via /api/assistant/chat.');
  } else {
    h.evidence.fail(
      'Intent classifier returns generic reply, no create_customer proposal returned. Proposal types DB row (if any): ' +
        JSON.stringify(db.rows)
    );
  }
});

matrixTest('AST-02', 'Create estimate via assistant', async (h) => {
  const prompt = `Draft an estimate for job ${h.tenantA.jobId} — 2 hours of HVAC diagnostic labor at $120/hr.`;
  const asked = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat(prompt),
    token: h.tenantA.token,
    label: '02-chat',
    expectStatus: 200,
  });
  const reply = normalizeReply(asked.response.body);

  const db = await h.db.query({
    label: '02-recent-estimates',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, status, total_cents, created_at FROM estimates
          WHERE tenant_id = $1 AND created_at > now() - interval '5 minutes'
          ORDER BY created_at DESC LIMIT 3`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, '/assistant', '02-chat');

  if (reply.proposal && reply.proposal.type === 'Estimate') {
    h.evidence.pass(`Assistant returned Estimate proposal id=${reply.proposal.id}.`);
  } else {
    h.evidence.partial(
      `Assistant replied but no Estimate proposal in response. Recent estimates in DB: ${db.rowCount}. This may mean the LLM fallback path is active (no provider creds).`
    );
  }
});

matrixTest('AST-03', 'Revise estimate via assistant', async (h) => {
  // Create a draft directly via API first so we have a target
  const seed = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: {
      jobId: h.tenantA.jobId,
      lineItems: [
        {
          id: 'seed-labor',
          description: 'Labor',
          quantity: 1,
          unitPriceCents: 10000,
          totalCents: 10000,
          sortOrder: 0,
          taxable: true,
          category: 'labor',
        },
      ],
      discountCents: 0,
      taxRateBps: 0,
    },
    token: h.tenantA.token,
    label: '03-seed',
    expectStatus: 201,
  });
  const estimateId = (seed.response.body as { id: string }).id;

  const reviseResp = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat(`Please revise estimate ${estimateId} by adding a $75 parts charge.`),
    token: h.tenantA.token,
    label: '03-chat',
    expectStatus: 200,
  });
  const reply = normalizeReply(reviseResp.response.body);

  const db = await h.db.query({
    label: '03-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, total_cents, updated_at FROM estimates WHERE id = $1`,
    params: [estimateId],
  });

  await gotoUi(h, `/estimates/${estimateId}`, '03-detail');

  if (reply.proposal && reply.proposal.type === 'Estimate') {
    h.evidence.pass(`Assistant returned revision proposal id=${reply.proposal.id}.`);
  } else {
    h.evidence.partial('Assistant replied but no Estimate revision proposal surfaced via /api/assistant/chat.');
  }
});

matrixTest('AST-04', 'Create/send invoice via assistant', async (h) => {
  const prompt = `Create and send an invoice for job ${h.tenantA.jobId} totaling $250.`;
  const asked = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat(prompt),
    token: h.tenantA.token,
    label: '04-chat',
    expectStatus: 200,
  });
  const reply = normalizeReply(asked.response.body);

  const db = await h.db.query({
    label: '04-recent-invoices',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, status, issued_at FROM invoices
          WHERE tenant_id = $1 AND created_at > now() - interval '5 minutes'
          ORDER BY created_at DESC LIMIT 3`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, '/assistant', '04-chat');

  const drafted = !!(reply.proposal && reply.proposal.type === 'Invoice');
  const issued = (db.rows as Array<{ status: string; issued_at: string | null }>).some(
    (r) => r.status === 'open' && r.issued_at
  );

  if (drafted && issued) {
    h.evidence.pass();
  } else if (drafted) {
    h.evidence.partial('Invoice proposal surfaced but send/issue step did not run. No send_invoice proposal type exists.');
  } else {
    h.evidence.fail('Assistant did not return an Invoice proposal.');
  }
});

matrixTest('AST-05', 'Payment status query via assistant', async (h) => {
  const resp = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat('Which of my invoices from the last month are unpaid?'),
    token: h.tenantA.token,
    label: '05-chat',
    expectStatus: 200,
  });
  const reply = normalizeReply(resp.response.body);

  // Ground-truth from DB so the report can compare
  const db = await h.db.query({
    label: '05-unpaid-truth',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, invoice_number, status, amount_due_cents
          FROM invoices WHERE tenant_id = $1 AND status IN ('open','partially_paid','draft')`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, '/assistant', '05-chat');

  const looksLikeSummary = /unpaid|open|owed|due/i.test(reply.content);
  if (looksLikeSummary && reply.content.match(/\b\d+\b/)) {
    h.evidence.partial(
      `Assistant replied with a narrative summary but no structured query intent exists. DB truth has ${db.rowCount} unpaid.`
    );
  } else {
    h.evidence.fail('No payment-status query capability. Intent classifier has no query intents.');
  }
});

matrixTest('AST-06', 'Failure handling + recovery', async (h) => {
  // Baseline estimate count BEFORE the bad request. Earlier AST rows seed
  // estimates, so an absolute "rows created in the last 30s" check
  // false-positives — we must measure the delta caused by THIS request.
  const before = await h.db.query({
    label: '06-baseline',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM estimates WHERE tenant_id = $1`,
    params: [h.tenantA.tenantId],
  });
  const baselineCount = (before.rows[0] as { c: number }).c;

  // Force a validation failure — empty content string.
  const resp = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: { messages: [{ role: 'user', content: '' }] },
    token: h.tenantA.token,
    label: '06-bad-input',
    expectStatus: [400, 422],
  });
  expect([400, 422]).toContain(resp.response.status);

  const after = await h.db.query({
    label: '06-no-new-rows',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM estimates WHERE tenant_id = $1`,
    params: [h.tenantA.tenantId],
  });
  const created = (after.rows[0] as { c: number }).c - baselineCount;

  await gotoUi(h, '/assistant', '06-error');

  if (created === 0) {
    h.evidence.pass('Invalid request returned clear error and no downstream rows were created.');
  } else {
    h.evidence.fail(`Invalid request caused ${created} new estimate rows — validation bypassed.`);
  }
});

matrixTest('AST-07', 'Multi-step orchestration (customer → estimate → invoice)', async (h) => {
  const prompt =
    `New customer Jane Smith, phone 555-0101, then draft an estimate for her for a water heater install at $1200, ` +
    `then create and send the invoice.`;
  const asked = await h.api.call({
    method: 'POST',
    path: '/api/assistant/chat',
    body: buildChat(prompt),
    token: h.tenantA.token,
    label: '07-chat',
    expectStatus: 200,
  });
  const reply = normalizeReply(asked.response.body);

  // Look for FK chain: a customer-estimate-invoice linkage created in the last minute.
  const db = await h.db.query({
    label: '07-chain-check',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT c.id AS customer_id, e.id AS estimate_id, i.id AS invoice_id
          FROM customers c
          LEFT JOIN jobs j ON j.customer_id = c.id AND j.tenant_id = c.tenant_id
          LEFT JOIN estimates e ON e.job_id = j.id AND e.tenant_id = c.tenant_id
          LEFT JOIN invoices i ON i.estimate_id = e.id AND i.tenant_id = c.tenant_id
          WHERE c.tenant_id = $1
            AND c.created_at > now() - interval '2 minutes'
            AND c.display_name ILIKE 'Jane Smith%'
          ORDER BY c.created_at DESC
          LIMIT 1`,
    params: [h.tenantA.tenantId],
  });

  await gotoUi(h, '/assistant', '07-chat');

  const row = db.rows[0] as
    | { customer_id: string; estimate_id: string | null; invoice_id: string | null }
    | undefined;
  if (row && row.estimate_id && row.invoice_id) {
    h.evidence.pass();
  } else if (reply.proposal) {
    h.evidence.fail(
      `Assistant returned a single proposal (type=${reply.proposal.type}) but did not chain customer→estimate→invoice. No orchestration support exists.`
    );
  } else {
    h.evidence.fail('No proposal chain produced and no DB linkage created. Orchestration not implemented.');
  }
});

// ---------------- helpers ----------------

interface AssistantReplyRaw {
  message?: {
    content?: string;
    proposal?: { id: string; type: string } | null;
  };
  taskType?: string;
  model?: string;
}

interface AssistantReply {
  content: string;
  proposal: { id: string; type: string } | null;
}

function normalizeReply(body: unknown): AssistantReply {
  const raw = (body ?? {}) as AssistantReplyRaw;
  return {
    content: raw.message?.content ?? '',
    proposal: raw.message?.proposal ?? null,
  };
}

function buildChat(content: string) {
  return {
    messages: [{ role: 'user', content }],
    stream: false,
  };
}

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
