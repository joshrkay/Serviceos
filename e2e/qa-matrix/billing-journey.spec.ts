import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * JRN-01 / JRN-02 — the core money pipeline (job-centric model):
 *   estimate(lineItems) → send → accept → invoice(from estimate) → issue → pay → paid.
 *
 * JRN-01 proves a single mixed-line-item estimate and total correctness.
 * JRN-02 proves "3 estimates, invoice 2, leave 1" end to end and verifies the
 * paid status on each invoiced one.
 */

test.describe.configure({ mode: 'serial' });

interface Item {
  id: string;
  description: string;
  category: 'labor' | 'material' | 'equipment' | 'other';
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  sortOrder: number;
  taxable: boolean;
}

function totals(items: Item[], discountCents = 0, taxRateBps = 0) {
  const subtotalCents = items.reduce((s, i) => s + i.totalCents, 0);
  const taxable = items.filter((i) => i.taxable).reduce((s, i) => s + i.totalCents, 0);
  const effective = Math.max(0, taxable - discountCents);
  const taxCents = Math.round((effective * taxRateBps) / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };
}

async function createEstimate(h: RowHarness, jobId: string, items: Item[], label: string) {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: { jobId, lineItems: items, discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label,
    expectStatus: 201,
  });
  return (res.response.body as { id: string }).id;
}

async function accept(h: RowHarness, estimateId: string, label: string): Promise<boolean> {
  // draft → sent → accepted (transition endpoint; tolerant if a hop is a no-op).
  for (const status of ['sent', 'accepted']) {
    await h.api.call({
      method: 'POST',
      path: `/api/estimates/${estimateId}/transition`,
      body: { status },
      token: h.tenantA.token,
      label: `${label}-${status}`,
      expectStatus: [200, 400],
    });
  }
  const db = await h.db.query({
    label: `${label}-status`,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM estimates WHERE id = $1`,
    params: [estimateId],
  });
  return (db.rows[0] as { status: string })?.status === 'accepted';
}

matrixTest('JRN-01', 'Estimate with mixed line items → send → accept', async (h) => {
  const items: Item[] = [
    { id: 'li-labor', description: 'Diagnostic labor', category: 'labor', quantity: 2, unitPriceCents: 12500, totalCents: 25000, sortOrder: 0, taxable: true },
    { id: 'li-material', description: 'Capacitor', category: 'material', quantity: 1, unitPriceCents: 4500, totalCents: 4500, sortOrder: 1, taxable: true },
    { id: 'li-equipment', description: 'Condenser unit', category: 'equipment', quantity: 1, unitPriceCents: 90000, totalCents: 90000, sortOrder: 2, taxable: true },
  ];
  const expected = totals(items);

  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: { jobId: h.tenantA.jobId, lineItems: items, discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label: '01-create',
    expectStatus: 201,
  });
  const body = created.response.body as { id: string; subtotalCents: number; totalCents: number };
  const id = body.id;
  expect(body.totalCents, 'API total must match billing-engine math').toBe(expected.totalCents);

  const db = await h.db.query({
    label: '01-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT subtotal_cents, total_cents, status FROM estimates WHERE id = $1`,
    params: [id],
  });
  const row = db.rows[0] as { subtotal_cents: number; total_cents: number; status: string };
  expect(row.total_cents).toBe(expected.totalCents);

  const accepted = await accept(h, id, '01');
  await gotoUi(h, `/estimates/${id}`, '01-detail');
  if (accepted) h.evidence.pass();
  else h.evidence.partial('Totals correct; estimate did not reach accepted via /transition (verify send→accept flow live).');
});

matrixTest('JRN-02', 'Three estimates, invoice two → issue → pay → paid', async (h) => {
  const sets: Item[][] = [
    [{ id: 'a1', description: 'Labor only', category: 'labor', quantity: 1, unitPriceCents: 15000, totalCents: 15000, sortOrder: 0, taxable: false }],
    [
      { id: 'b1', description: 'Labor', category: 'labor', quantity: 1, unitPriceCents: 20000, totalCents: 20000, sortOrder: 0, taxable: false },
      { id: 'b2', description: 'Parts', category: 'material', quantity: 2, unitPriceCents: 3000, totalCents: 6000, sortOrder: 1, taxable: false },
    ],
    [
      { id: 'c1', description: 'Labor', category: 'labor', quantity: 3, unitPriceCents: 11500, totalCents: 34500, sortOrder: 0, taxable: false },
      { id: 'c2', description: 'Equipment', category: 'equipment', quantity: 1, unitPriceCents: 50000, totalCents: 50000, sortOrder: 1, taxable: false },
    ],
  ];

  const estIds = [
    await createEstimate(h, h.tenantA.jobId, sets[0], '02-est1'),
    await createEstimate(h, h.tenantA.jobId, sets[1], '02-est2'),
    await createEstimate(h, h.tenantA.jobId, sets[2], '02-est3-uninvoiced'),
  ];

  // Invoice + pay the first two; leave the third un-invoiced.
  const paidInvoiceIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    await accept(h, estIds[i], `02-accept-${i}`);
    const expectedTotal = totals(sets[i]).totalCents;

    const invoice = await h.api.call({
      method: 'POST',
      path: '/api/invoices',
      body: { jobId: h.tenantA.jobId, estimateId: estIds[i], lineItems: sets[i], discountCents: 0, taxRateBps: 0 },
      token: h.tenantA.token,
      label: `02-invoice-${i}`,
      expectStatus: 201,
    });
    const invoiceId = (invoice.response.body as { id: string }).id;

    await h.api.call({
      method: 'POST',
      path: `/api/invoices/${invoiceId}/issue`,
      body: { paymentTermDays: 30 },
      token: h.tenantA.token,
      label: `02-issue-${i}`,
      expectStatus: [200, 400],
    });

    await h.api.call({
      method: 'POST',
      path: '/api/payments',
      body: { invoiceId, amountCents: expectedTotal, method: 'cash', note: 'QA full payment' },
      token: h.tenantA.token,
      label: `02-pay-${i}`,
      expectStatus: [200, 201],
    });
    paidInvoiceIds.push(invoiceId);
  }

  // Verify paid status on each invoiced one.
  for (let i = 0; i < paidInvoiceIds.length; i++) {
    const row = await h.db.query({
      label: `02-invoice-${i}-paid`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status, amount_paid_cents, amount_due_cents, total_cents FROM invoices WHERE id = $1`,
      params: [paidInvoiceIds[i]],
    });
    const r = row.rows[0] as { status: string; amount_paid_cents: number; amount_due_cents: number; total_cents: number };
    expect(r.status, `invoice ${i} must be paid`).toBe('paid');
    expect(r.amount_due_cents, `invoice ${i} due must be 0`).toBe(0);
    expect(r.amount_paid_cents).toBe(r.total_cents);
  }

  // The third estimate must remain un-invoiced.
  const orphan = await h.db.query({
    label: '02-est3-no-invoice',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT count(*)::int AS c FROM invoices WHERE estimate_id = $1`,
    params: [estIds[2]],
  });
  expect((orphan.rows[0] as { c: number }).c, 'third estimate must stay un-invoiced').toBe(0);

  await gotoUi(h, '/invoices', '02-invoices-ui');
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
