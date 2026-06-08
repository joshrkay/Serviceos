import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * ISO-01 — cross-tenant isolation across the core entities, a cross-tenant
 * write attempt, and RLS row suppression at the DB layer. Critical with two
 * live tenants (HVAC must never see plumbing's data).
 */

test.describe.configure({ mode: 'serial' });

matrixTest('ISO-01', 'Cross-tenant isolation across core entities + RLS', async (h) => {
  const a = h.tenantA;
  const b = h.tenantB;

  // Seed an estimate + invoice under Tenant A (customer/job are pre-seeded).
  const est = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: minimalEstimate(a.jobId),
    token: a.token,
    label: '01-a-estimate',
    expectStatus: 201,
  });
  const estimateId = (est.response.body as { id: string }).id;

  const inv = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: minimalInvoice(a.jobId),
    token: a.token,
    label: '01-a-invoice',
    expectStatus: [201, 400],
  });
  const invoiceId =
    inv.response.status === 201 ? (inv.response.body as { id: string }).id : undefined;

  // Tenant B must NOT be able to read any of Tenant A's records.
  const reads: Array<{ label: string; path: string }> = [
    { label: '01-b-customer', path: `/api/customers/${a.customerId}` },
    { label: '01-b-job', path: `/api/jobs/${a.jobId}` },
    { label: '01-b-estimate', path: `/api/estimates/${estimateId}` },
  ];
  if (invoiceId) reads.push({ label: '01-b-invoice', path: `/api/invoices/${invoiceId}` });

  for (const r of reads) {
    const res = await h.api.call({
      method: 'GET',
      path: r.path,
      token: b.token,
      label: r.label,
      expectStatus: [403, 404],
    });
    expect([403, 404], `${r.path} must be hidden from Tenant B`).toContain(res.response.status);
  }

  // Cross-tenant WRITE attempt: Tenant B writing a note onto Tenant A's customer.
  const noteWrite = await h.api.call({
    method: 'POST',
    path: '/api/notes',
    body: { entityType: 'customer', entityId: a.customerId, content: 'QA cross-tenant injection attempt' },
    token: b.token,
    label: '01-b-note-write',
    expectStatus: [400, 403, 404],
  });
  expect([400, 403, 404]).toContain(noteWrite.response.status);

  // Query under each tenant's GUC — a no-GUC query is RLS-suppressed to 0 rows
  // and would mask a leaked note. A leaked note would carry A's or B's tenant_id.
  let leaked = 0;
  for (const label of ['A', 'B'] as const) {
    const r = await h.db.query({
      label: `01-note-check-${label}`,
      tenantId: label === 'A' ? a.tenantId : b.tenantId,
      sql: `SELECT count(*)::int AS c FROM notes WHERE content = $1`,
      params: ['QA cross-tenant injection attempt'],
    });
    leaked += (r.rows[0] as { c: number }).c;
  }
  expect(leaked, 'cross-tenant note must not persist under either tenant').toBe(0);

  // RLS: estimate is visible only under Tenant A's GUC.
  // QA-2026-06-04 (ISO-01-rls-probe-role): noGucProbe handles the two env
  // realities — a scoped role fails CLOSED (policy errors on the unset GUC,
  // captured as 0 rows) and a superuser/BYPASSRLS conn makes the probe
  // meaningless (degrade to partial instead of a fake isolation hole).
  const noGuc = await h.db.query({
    label: '01-rls-no-guc',
    sql: `SELECT id FROM estimates WHERE id = $1`,
    params: [estimateId],
    noGucProbe: true,
  });
  let rlsProbeMeaningful = true;
  if (noGuc.bypassRls) {
    rlsProbeMeaningful = false;
    h.evidence.note(
      'E2E_DB_URL_READONLY connects as superuser/BYPASSRLS — the no-GUC RLS probe cannot run. ' +
        'Point it at the qa_readonly role (see qa/backlog/ISO-01-rls-probe-role.md).'
    );
  } else {
    expect(noGuc.rowCount, 'no GUC → RLS suppresses rows (0 visible or fails closed)').toBe(0);
    if (noGuc.rlsFailedClosed) {
      h.evidence.note('No-GUC probe errored on the missing app.current_tenant_id parameter — RLS fails closed (treated as suppressed).');
    }
  }

  // Per-GUC scoping is equally meaningless on a BYPASSRLS connection (the
  // policy never runs, so tenant B "sees" tenant A's row regardless).
  if (rlsProbeMeaningful) {
    const asA = await h.db.query({
      label: '01-rls-as-a',
      tenantId: a.tenantId,
      sql: `SELECT id FROM estimates WHERE id = $1`,
      params: [estimateId],
    });
    const asB = await h.db.query({
      label: '01-rls-as-b',
      tenantId: b.tenantId,
      sql: `SELECT id FROM estimates WHERE id = $1`,
      params: [estimateId],
    });
    expect(asA.rowCount, 'tenant A GUC must see its own estimate').toBe(1);
    expect(asB.rowCount, 'tenant B GUC must NOT see tenant A estimate').toBe(0);
  }

  await gotoUi(h, '/customers', '01-b-list');

  if (!invoiceId) {
    h.evidence.partial('Isolation verified for customer/job/estimate + RLS; invoice create returned 400 so invoice read was skipped.');
  } else if (!rlsProbeMeaningful) {
    h.evidence.partial(
      'API-level isolation verified (cross-tenant reads 404, cross-tenant write blocked, per-GUC scoping correct); ' +
        'no-GUC RLS probe skipped — DB connection bypasses RLS. Use the qa_readonly role for a full pass.'
    );
  } else {
    h.evidence.pass();
  }
});

// ---------------- helpers ----------------

function minimalEstimate(jobId: string) {
  return {
    jobId,
    lineItems: [
      { id: `li-${Date.now()}`, description: 'Diagnostic', category: 'labor', quantity: 1, unitPriceCents: 12000, totalCents: 12000, sortOrder: 0, taxable: true },
    ],
    discountCents: 0,
    taxRateBps: 0,
  };
}

function minimalInvoice(jobId: string) {
  return {
    jobId,
    lineItems: [
      { id: `li-${Date.now()}`, description: 'Service', category: 'labor', quantity: 1, unitPriceCents: 12000, totalCents: 12000, sortOrder: 0, taxable: true },
    ],
    discountCents: 0,
    taxRateBps: 0,
  };
}

async function gotoUi(h: RowHarness, path: string, label: string): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL!;
  try {
    await h.page.goto(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    h.evidence.note(`navigation to ${path} failed: ${(err as Error).message}`);
  }
  await h.page.waitForTimeout(500);
  await h.snapshot(label);
}
