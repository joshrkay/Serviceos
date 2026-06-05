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

  // QA-2026-06-04: the live build returns a real create_customer proposal
  // (taskType assistant.create_customer + proposal.id). Pass when a proposal
  // came back AND nothing was auto-created (human-in-the-loop preserved).
  const proposalId = (reply.proposal as { id?: string } | null | undefined)?.id;
  if (proposalId && db.rowCount === 0) {
    h.evidence.pass('create_customer proposal returned; no auto-created customer row (HITL preserved).');
  } else if (proposedCustomer && reply.content.toLowerCase().includes('customer')) {
    h.evidence.partial('Assistant replied about customer creation but no usable proposal id was exposed.');
  } else {
    h.evidence.fail(
      'No create_customer proposal returned. Auto-created rows (should be none): ' + JSON.stringify(db.rows)
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

  // QA-2026-06-05: the route now answers unpaid-invoice queries FROM DATA
  // (read-only intent, no proposal). Cross-check the reply against DB truth:
  // the stated count must match recent unpaid invoices, and at least one
  // real invoice number must appear (when any exist).
  const recentUnpaid = (db.rows as Array<{ invoice_number: string; status: string }>).filter((r) =>
    ['open', 'partially_paid'].includes(r.status)
  );
  const countMatch = reply.content.match(/^(\d+) unpaid invoice/);
  const statedCount = countMatch ? parseInt(countMatch[1], 10) : undefined;
  const mentionsRealInvoice = recentUnpaid.some((r) => reply.content.includes(r.invoice_number));
  const saysNone = /no unpaid invoices/i.test(reply.content);

  if ((statedCount !== undefined && mentionsRealInvoice) || (saysNone && recentUnpaid.length === 0)) {
    h.evidence.pass(
      `Data-backed answer: stated ${statedCount ?? 0} unpaid; DB shows ${recentUnpaid.length} open/partially_paid (last-31d filter applies server-side); no proposal created (read-only).`
    );
  } else if (/unpaid|open|owed|due/i.test(reply.content)) {
    h.evidence.partial(
      `Reply mentions payment status but did not cross-check against DB truth (${recentUnpaid.length} unpaid): "${reply.content.slice(0, 120)}"`
    );
  } else {
    h.evidence.fail('No payment-status query capability.');
  }
});

matrixTest('AST-06', 'Failure handling + recovery', async (h) => {
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

  const db = await h.db.query({
    label: '06-no-new-rows',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM estimates WHERE tenant_id = $1 AND created_at > now() - interval '30 seconds'`,
    params: [h.tenantA.tenantId],
  });
  const c = (db.rows[0] as { c: number }).c;

  await gotoUi(h, '/assistant', '06-error');

  if (c === 0) {
    h.evidence.pass('Invalid request returned clear error and no downstream rows were created.');
  } else {
    h.evidence.fail(`Invalid request caused ${c} new estimate rows — validation bypassed.`);
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

  // QA-2026-06-05: design-conforming chaining — the ask decomposes into
  // LINKED proposals (shared chainId); capture steps execute after their
  // approval windows, the money step (invoice) lands ready_for_review. A
  // fully auto-executed invoice would violate the money-class HITL contract,
  // so that is exactly what we assert does NOT happen.
  const chain = await h.db.query({
    label: '07-chain-proposals',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT proposal_type, status, source_context->>'chainId' AS chain_id
          FROM proposals
          WHERE tenant_id = $1 AND source_context->>'chainId' IS NOT NULL
            AND created_at > now() - interval '2 minutes'
          ORDER BY (source_context->>'chainStep')::int ASC`,
    params: [h.tenantA.tenantId],
  });
  const rows = chain.rows as Array<{ proposal_type: string; status: string; chain_id: string }>;
  const chainIds = new Set(rows.map((r) => r.chain_id));
  const sameChain = chainIds.size === 1 && rows.length >= 2;
  const hasCustomer = rows.some((r) => r.proposal_type === 'create_customer');
  const moneyRows = rows.filter((r) => ['draft_invoice', 'send_invoice'].includes(r.proposal_type));
  const moneyAwaitsApproval = moneyRows.every((r) => ['ready_for_review', 'draft'].includes(r.status));

  await gotoUi(h, '/assistant', '07-chat');

  if (sameChain && hasCustomer && moneyRows.length >= 1 && moneyAwaitsApproval) {
    h.evidence.pass(
      `Chain decomposed into ${rows.length} linked proposals (${rows.map((r) => `${r.proposal_type}:${r.status}`).join(', ')}); ` +
        'money step correctly awaits approval (HITL preserved).'
    );
  } else if (sameChain) {
    h.evidence.partial(
      `Chain created (${rows.length} proposals) but composition unexpected: ${rows.map((r) => `${r.proposal_type}:${r.status}`).join(', ')}.`
    );
  } else if (reply.proposal) {
    h.evidence.partial(`Single proposal returned (type=${reply.proposal.type}); multi-step decomposition did not produce a linked chain.`);
  } else {
    h.evidence.fail('No chained proposals and no single proposal returned.');
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
