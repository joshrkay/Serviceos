import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * INV-01 — invoice lifecycle: create (draft) → issue (open, issuedAt) →
 *          void, each persisted in the DB.
 * INV-02 — an invalid transition (draft → void) is rejected and the invoice
 *          stays draft (state-machine enforcement).
 *
 * Each row seeds its own customer + location + job, then an invoice against
 * that job. No AI key required.
 */

test.describe.configure({ mode: 'serial' });

function lineItem(id: string, desc: string, cents: number) {
  return {
    id,
    description: desc,
    category: 'labor' as const,
    quantity: 1,
    unitPriceCents: cents,
    totalCents: cents,
    sortOrder: 0,
    taxable: true,
  };
}

async function seedJob(h: RowHarness, label: string): Promise<string> {
  const { token } = h.tenantA;
  const stamp = Date.now();
  const c = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: { firstName: 'Inv', lastName: `QA-${label}-${stamp}`, primaryPhone: `+1555${String(stamp).slice(-7)}` },
    token,
    label: `${label}-customer`,
    expectStatus: 201,
  });
  const customerId = (c.response.body as { id: string }).id;
  const loc = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: { customerId, street1: '1 Inv Way', city: 'Testville', state: 'CA', postalCode: '90001' },
    token,
    label: `${label}-location`,
    expectStatus: 201,
  });
  const locationId = (loc.response.body as { id: string }).id;
  const job = await h.api.call({
    method: 'POST',
    path: '/api/jobs',
    body: { customerId, locationId, summary: `QA invoice job ${label}`, priority: 'normal' },
    token,
    label: `${label}-job`,
    expectStatus: 201,
  });
  return (job.response.body as { id: string }).id;
}

async function createInvoice(h: RowHarness, jobId: string, label: string): Promise<string> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: { jobId, lineItems: [lineItem('li-1', 'Service call', 50_000)] },
    token: h.tenantA.token,
    label,
    expectStatus: 201,
  });
  const id = (res.response.body as { id: string }).id;
  expect(id, 'invoice create must return an id').toBeTruthy();
  return id;
}

async function dbInvoice(h: RowHarness, label: string, id: string): Promise<{ status: string; issued_at: string | null }> {
  const row = await h.db.query({
    label,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status, issued_at FROM invoices WHERE id = $1`,
    params: [id],
  });
  expect(row.rowCount, `${label}: invoice row must exist`).toBe(1);
  return row.rows[0] as { status: string; issued_at: string | null };
}

matrixTest('INV-01', 'Invoice issue → void lifecycle', async (h) => {
  const jobId = await seedJob(h, '01');
  const invoiceId = await createInvoice(h, jobId, '01-create');
  expect((await dbInvoice(h, '01-status-draft', invoiceId)).status, 'new invoice is draft').toBe('draft');

  await h.api.call({ method: 'POST', path: `/api/invoices/${invoiceId}/issue`, token: h.tenantA.token, label: '01-issue', expectStatus: 200 });
  const issued = await dbInvoice(h, '01-status-open', invoiceId);
  expect(issued.status, 'issued invoice moves to open').toBe('open');
  expect(issued.issued_at, 'issue stamps issued_at').toBeTruthy();

  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${invoiceId}/transition`,
    body: { status: 'void' },
    token: h.tenantA.token,
    label: '01-void',
    expectStatus: 200,
  });
  expect((await dbInvoice(h, '01-status-void', invoiceId)).status, 'voided invoice persists status=void').toBe('void');

  await gotoUi(h, '/invoices', '01-invoices-ui');
  h.evidence.pass();
});

matrixTest('INV-02', 'Invalid invoice transition rejected', async (h) => {
  const jobId = await seedJob(h, '02');
  const invoiceId = await createInvoice(h, jobId, '02-create');
  // draft may only go to open/canceled — draft → void must be refused.
  const res = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${invoiceId}/transition`,
    body: { status: 'void' },
    token: h.tenantA.token,
    label: '02-invalid',
  });
  expect(res.response.status, 'invalid transition must be a 4xx').toBeGreaterThanOrEqual(400);
  expect(res.response.status, 'invalid transition must not be a 5xx').toBeLessThan(500);
  expect((await dbInvoice(h, '02-status-after', invoiceId)).status, 'rejected transition leaves invoice draft').toBe('draft');
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
  await h.page.waitForTimeout(500);
  await h.snapshot(label);
}
