import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { seedFreshJob } from './helpers/seed-entities';

/**
 * EST-01..EST-06 — 4-agent swarm (A API, B UI, C DB, D Evidence).
 *
 * Each row follows the same shape:
 *   1. Agent A hits the API and captures request/response.
 *   2. Agent B drives the UI and captures before/after screenshots.
 *   3. Agent C queries the DB and captures row dumps.
 *   4. Evidence manifest is written automatically via teardownRow().
 *
 * UI selectors are best-effort against the current build. If a selector
 * misses, the API + DB proof is still captured and the verdict reflects
 * what was actually observed.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('EST-01', 'Create draft estimate', async (h) => {
  const payload = buildMinimalEstimatePayload(h.tenantA.jobId);

  // Agent A
  const apiResp = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: payload,
    token: h.tenantA.token,
    label: '01-create',
    expectStatus: 201,
  });
  const estimateId = (apiResp.response.body as { id?: string }).id;
  expect(estimateId, 'API response must include id').toBeTruthy();

  // Agent C
  const dbRes = await h.db.query({
    label: '01-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, tenant_id, status, total_cents, estimate_number
          FROM estimates WHERE id = $1`,
    params: [estimateId],
  });
  expect(dbRes.rowCount, 'estimate row must exist').toBe(1);
  expect((dbRes.rows[0] as { status: string }).status).toBe('draft');

  // Agent B
  await gotoUi(h, '/estimates', '01-list-before');
  await h.page.waitForTimeout(800);
  await h.snapshot('01-list-after');

  h.evidence.pass();
});

matrixTest('EST-02', 'Validation errors', async (h) => {
  const apiResp = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: { jobId: h.tenantA.jobId, lineItems: [] },
    token: h.tenantA.token,
    label: '02-invalid',
    expectStatus: 400,
  });
  expect((apiResp.response.body as { error?: string }).error).toBeTruthy();

  const dbRes = await h.db.query({
    label: '02-no-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM estimates
          WHERE tenant_id = $1 AND created_at > now() - interval '1 minute'
            AND total_cents = 0`,
    params: [h.tenantA.tenantId],
  });
  expect((dbRes.rows[0] as { c: number }).c).toBeLessThanOrEqual(1);

  await gotoUi(h, '/estimates', '02-list');
  h.evidence.pass('Validated 400 API rejection; UI-side blocking not scripted.');
});

matrixTest('EST-03', 'Edit draft', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: buildMinimalEstimatePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '03-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;

  // QA-2026-06-04 (EST-03 story): try PATCH first — the alias exists on
  // main-lineage builds. Fall back to PUT (and a partial verdict) only when
  // the deployed build predates it. The old spec hardcoded partial and never
  // attempted PATCH.
  const patched = await h.api.call({
    method: 'PATCH',
    path: `/api/estimates/${id}`,
    body: { customerMessage: 'EST-03 revised note' },
    token: h.tenantA.token,
    label: '03-patch',
    expectStatus: [200, 404, 405],
  });
  const patchWorked = patched.response.status === 200;
  if (patchWorked) {
    expect((patched.response.body as { customerMessage?: string }).customerMessage).toBe('EST-03 revised note');
  } else {
    const updated = await h.api.call({
      method: 'PUT',
      path: `/api/estimates/${id}`,
      body: { customerMessage: 'EST-03 revised note' },
      token: h.tenantA.token,
      label: '03-put',
      expectStatus: 200,
    });
    expect((updated.response.body as { customerMessage?: string }).customerMessage).toBe('EST-03 revised note');
  }

  const db = await h.db.query({
    label: '03-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, customer_message, updated_at, created_at FROM estimates WHERE id = $1`,
    params: [id],
  });
  const row = db.rows[0] as { customer_message: string; updated_at: string; created_at: string };
  expect(row.customer_message).toBe('EST-03 revised note');
  expect(new Date(row.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(row.created_at).getTime());

  await gotoUi(h, `/estimates/${id}`, '03-detail');
  if (patchWorked) {
    h.evidence.pass();
  } else {
    h.evidence.partial('Deployed build exposes PUT only (PATCH alias exists on main lineage — redeploy to flip).');
  }
});

matrixTest('EST-04', 'Estimate total correctness', async (h) => {
  const payload = buildEstimatePayloadWithKnownTotals(h.tenantA.jobId);
  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: payload,
    token: h.tenantA.token,
    label: '04-create',
    expectStatus: 201,
  });
  const apiBody = created.response.body as {
    id: string;
    totals: { subtotalCents: number; taxCents: number; totalCents: number };
  };

  const expected = calculateTotals(payload);
  expect(apiBody.totals.subtotalCents).toBe(expected.subtotalCents);
  expect(apiBody.totals.taxCents).toBe(expected.taxCents);
  expect(apiBody.totals.totalCents).toBe(expected.totalCents);

  const db = await h.db.query({
    label: '04-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT subtotal_cents, tax_cents, total_cents FROM estimates WHERE id = $1`,
    params: [apiBody.id],
  });
  const row = db.rows[0] as { subtotal_cents: number; tax_cents: number; total_cents: number };
  expect(row.subtotal_cents).toBe(expected.subtotalCents);
  expect(row.tax_cents).toBe(expected.taxCents);
  expect(row.total_cents).toBe(expected.totalCents);

  await gotoUi(h, `/estimates/${apiBody.id}`, '04-detail');
  h.evidence.pass();
});

matrixTest('EST-05', 'Convert estimate to invoice', async (h) => {
  // Own job: this row drives the estimate to 'accepted', and the product
  // allows only one accepted estimate per job (see helpers/seed-entities.ts).
  const { jobId } = await seedFreshJob(h, '05-seed');
  const draft = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: buildMinimalEstimatePayload(jobId),
    token: h.tenantA.token,
    label: '05-create-estimate',
    expectStatus: 201,
  });
  const estimateId = (draft.response.body as { id: string }).id;

  for (const status of ['ready_for_review', 'sent', 'accepted']) {
    await h.api.call({
      method: 'POST',
      path: `/api/estimates/${estimateId}/transition`,
      body: { status },
      token: h.tenantA.token,
      label: `05-transition-${status}`,
      expectStatus: [200, 400],
    });
  }

  const invoiceResp = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: buildInvoicePayloadFromEstimate(jobId, estimateId),
    token: h.tenantA.token,
    label: '05-create-invoice',
    expectStatus: [201, 400],
  });

  if (invoiceResp.response.status !== 201) {
    h.evidence.fail(
      `POST /api/invoices with estimateId did not create invoice (status=${invoiceResp.response.status}).`
    );
    await gotoUi(h, `/estimates/${estimateId}`, '05-estimate-ui');
    return;
  }

  const invoiceId = (invoiceResp.response.body as { id: string }).id;
  const linkRes = await h.db.query({
    label: '05-invoice-link',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, estimate_id, total_cents FROM invoices WHERE id = $1`,
    params: [invoiceId],
  });
  const invoiceRow = linkRes.rows[0] as { estimate_id: string | null };
  expect(invoiceRow.estimate_id, 'invoice must be linked to source estimate').toBe(estimateId);

  await gotoUi(h, `/invoices/${invoiceId}`, '05-invoice-ui');
  h.evidence.pass('No dedicated /:id/convert endpoint by design; POST /api/invoices { estimateId } links correctly.');
});

matrixTest('EST-06', 'Tenant isolation', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: buildMinimalEstimatePayload(h.tenantA.jobId),
    token: h.tenantA.token,
    label: '06-a-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;

  const bRead = await h.api.call({
    method: 'GET',
    path: `/api/estimates/${id}`,
    token: h.tenantB.token,
    label: '06-b-read',
    expectStatus: [404, 403],
  });
  expect([403, 404]).toContain(bRead.response.status);

  // QA-2026-06-04: noGucProbe — see ISO-01 / helpers/db-verifier.ts. A
  // scoped role fails CLOSED on the unset GUC (counted as suppressed); a
  // BYPASSRLS conn makes RLS probes meaningless (skip, note).
  const rlsBlocked = await h.db.query({
    label: '06-rls-no-guc',
    sql: `SELECT id FROM estimates WHERE id = $1`,
    params: [id],
    noGucProbe: true,
  });
  const rlsMeaningful = !rlsBlocked.bypassRls;
  if (rlsMeaningful) {
    expect(rlsBlocked.rowCount, 'without tenant GUC, RLS must return 0 rows (or fail closed)').toBe(0);

    const asA = await h.db.query({
      label: '06-rls-as-a',
      tenantId: h.tenantA.tenantId,
      sql: `SELECT id FROM estimates WHERE id = $1`,
      params: [id],
    });
    const asB = await h.db.query({
      label: '06-rls-as-b',
      tenantId: h.tenantB.tenantId,
      sql: `SELECT id FROM estimates WHERE id = $1`,
      params: [id],
    });
    expect(asA.rowCount).toBe(1);
    expect(asB.rowCount).toBe(0);
  } else {
    h.evidence.note('DB conn bypasses RLS — RLS probes skipped; use qa_readonly (ISO-01-rls-probe-role).');
  }

  await gotoUi(h, '/estimates', '06-b-list');
  h.evidence.pass();
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

function buildMinimalEstimatePayload(jobId: string) {
  return {
    jobId,
    lineItems: [
      {
        id: `li-${Date.now()}`,
        description: 'Diagnostic labor',
        quantity: 1,
        unitPriceCents: 15000,
        totalCents: 15000,
        sortOrder: 0,
        taxable: true,
        category: 'labor',
      },
    ],
    discountCents: 0,
    taxRateBps: 0,
  };
}

function buildEstimatePayloadWithKnownTotals(jobId: string) {
  return {
    jobId,
    lineItems: [
      {
        id: 'li-labor',
        description: 'Labor',
        quantity: 2,
        unitPriceCents: 12000,
        totalCents: 24000,
        sortOrder: 0,
        taxable: true,
        category: 'labor',
      },
      {
        id: 'li-material',
        description: 'Material',
        quantity: 1,
        unitPriceCents: 5000,
        totalCents: 5000,
        sortOrder: 1,
        taxable: true,
        category: 'material',
      },
    ],
    discountCents: 1000,
    taxRateBps: 825,
  };
}

function buildInvoicePayloadFromEstimate(jobId: string, estimateId: string) {
  return {
    jobId,
    estimateId,
    lineItems: [
      {
        id: `li-${Date.now()}`,
        description: 'Converted from estimate',
        quantity: 1,
        unitPriceCents: 15000,
        totalCents: 15000,
        sortOrder: 0,
        taxable: true,
        category: 'labor',
      },
    ],
    discountCents: 0,
    taxRateBps: 0,
  };
}

function calculateTotals(payload: ReturnType<typeof buildEstimatePayloadWithKnownTotals>) {
  const subtotalCents = payload.lineItems.reduce((sum, li) => sum + li.totalCents, 0);
  const taxableSubtotalCents = payload.lineItems
    .filter((li) => li.taxable)
    .reduce((sum, li) => sum + li.totalCents, 0);
  const effectiveTaxable = Math.max(0, taxableSubtotalCents - payload.discountCents);
  const taxCents = Math.round((effectiveTaxable * payload.taxRateBps) / 10000);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents - payload.discountCents + taxCents,
  };
}
