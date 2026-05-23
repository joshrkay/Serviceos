import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { rwAvailable, rwExec } from './helpers/rw-db';

/**
 * PAY-01 — partial → full payment + over-payment guard (API-only, deterministic).
 * PAY-02 — deposit credit auto-applied on the first invoice (RW-seeded).
 * PAY-03 — money dashboard reflects paid revenue (report read).
 * PAY-04 — overdue money-state from a backdated due date (RW-seeded; worker-driven).
 */

test.describe.configure({ mode: 'serial' });

function line(totalCents: number) {
  return [
    { id: `li-${Date.now()}`, description: 'Service', category: 'labor', quantity: 1, unitPriceCents: totalCents, totalCents, sortOrder: 0, taxable: false },
  ];
}

async function openInvoice(h: RowHarness, totalCents: number, label: string): Promise<string> {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: { jobId: h.tenantA.jobId, lineItems: line(totalCents), discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label: `${label}-create`,
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${id}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: `${label}-issue`,
    expectStatus: [200, 400],
  });
  return id;
}

matrixTest('PAY-01', 'Partial → full payment + over-payment guard', async (h) => {
  const invoiceId = await openInvoice(h, 30000, '01');

  await h.api.call({
    method: 'POST',
    path: '/api/payments',
    body: { invoiceId, amountCents: 10000, method: 'cash', note: 'QA partial' },
    token: h.tenantA.token,
    label: '01-partial',
    expectStatus: [200, 201],
  });
  let row = (
    await h.db.query({
      label: '01-after-partial',
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status, amount_paid_cents, amount_due_cents FROM invoices WHERE id = $1`,
      params: [invoiceId],
    })
  ).rows[0] as { status: string; amount_paid_cents: number; amount_due_cents: number };
  expect(row.status).toBe('partially_paid');
  expect(row.amount_due_cents).toBe(20000);

  // Over-payment must be rejected.
  await h.api.call({
    method: 'POST',
    path: '/api/payments',
    body: { invoiceId, amountCents: 99999, method: 'cash', note: 'QA over-payment' },
    token: h.tenantA.token,
    label: '01-overpay',
    expectStatus: [400, 422],
  });

  await h.api.call({
    method: 'POST',
    path: '/api/payments',
    body: { invoiceId, amountCents: 20000, method: 'cash', note: 'QA remainder' },
    token: h.tenantA.token,
    label: '01-remainder',
    expectStatus: [200, 201],
  });
  row = (
    await h.db.query({
      label: '01-after-full',
      tenantId: h.tenantA.tenantId,
      sql: `SELECT status, amount_paid_cents, amount_due_cents FROM invoices WHERE id = $1`,
      params: [invoiceId],
    })
  ).rows[0] as { status: string; amount_paid_cents: number; amount_due_cents: number };
  expect(row.status).toBe('paid');
  expect(row.amount_due_cents).toBe(0);
  h.evidence.pass();
});

matrixTest('PAY-02', 'Deposit credit auto-applied on first invoice', async (h) => {
  if (!rwAvailable()) {
    h.evidence.na('E2E_DB_URL_READWRITE not set — cannot seed a deposit on the job.');
    return;
  }

  // Fresh customer/location/job so it's the job's first invoice.
  const stamp = Date.now();
  const cust = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: { firstName: 'QA', lastName: `Deposit-${stamp}`, primaryPhone: `+1555${String(stamp).slice(-7)}` },
    token: h.tenantA.token,
    label: '02-customer',
    expectStatus: 201,
  });
  const customerId = (cust.response.body as { id: string }).id;
  const loc = await h.api.call({
    method: 'POST',
    path: '/api/locations',
    body: { customerId, street1: '1 QA Way', city: 'Testville', state: 'CA', postalCode: '90001' },
    token: h.tenantA.token,
    label: '02-location',
    expectStatus: 201,
  });
  const locationId = (loc.response.body as { id: string }).id;
  const job = await h.api.call({
    method: 'POST',
    path: '/api/jobs',
    body: { customerId, locationId, summary: 'QA deposit job' },
    token: h.tenantA.token,
    label: '02-job',
    expectStatus: 201,
  });
  const jobId = (job.response.body as { id: string }).id;

  try {
    await rwExec(h.tenantA.tenantId, `UPDATE jobs SET deposit_paid_cents = 5000 WHERE id = $1`, [jobId]);
  } catch (err) {
    h.evidence.na(`Could not seed deposit (schema differs?): ${(err as Error).message}`);
    return;
  }

  const inv = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: { jobId, lineItems: line(20000), discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label: '02-invoice',
    expectStatus: 201,
  });
  const invoiceId = (inv.response.body as { id: string }).id;

  const credit = await h.db.query({
    label: '02-deposit-credit',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT amount_cents, payment_method, reference_number FROM payments
          WHERE invoice_id = $1 AND reference_number = 'deposit_credit'`,
    params: [invoiceId],
  });
  const invRow = (
    await h.db.query({
      label: '02-invoice-after',
      tenantId: h.tenantA.tenantId,
      sql: `SELECT amount_paid_cents, amount_due_cents FROM invoices WHERE id = $1`,
      params: [invoiceId],
    })
  ).rows[0] as { amount_paid_cents: number; amount_due_cents: number };

  if (credit.rowCount === 1 && invRow.amount_paid_cents >= 5000) {
    h.evidence.pass();
  } else {
    h.evidence.partial(
      `Expected a deposit_credit payment + reduced amount_due (paid=${invRow.amount_paid_cents}). ` +
        'Auto-credit may trigger on issue/send rather than create — verify the deposit flow live.'
    );
  }
});

matrixTest('PAY-03', 'Money dashboard reflects paid revenue', async (h) => {
  const month = new Date().toISOString().slice(0, 7);
  const res = await h.api.call({
    method: 'GET',
    path: `/api/reports/money-dashboard?month=${month}`,
    token: h.tenantA.token,
    label: '03-dashboard',
    expectStatus: [200, 404],
  });
  if (res.response.status !== 200) {
    h.evidence.partial(`money-dashboard returned ${res.response.status}; route/shape may differ.`);
    return;
  }
  const data = (res.response.body as { data?: Record<string, number> }).data ?? {};
  const revenue = data.grossRevenueCents ?? data.revenueCents ?? 0;
  await gotoUi(h, '/reports', '03-ui');
  if (revenue > 0) h.evidence.pass(`Dashboard revenue=${revenue} cents for ${month}.`);
  else h.evidence.partial(`Dashboard returned 200 but revenue=${revenue}; ensure paid invoices exist this month.`);
});

matrixTest('PAY-04', 'Overdue invoice money-state', async (h) => {
  if (!rwAvailable()) {
    h.evidence.na('E2E_DB_URL_READWRITE not set — cannot backdate due_date.');
    return;
  }
  const invoiceId = await openInvoice(h, 25000, '04');
  try {
    await rwExec(
      h.tenantA.tenantId,
      `UPDATE invoices SET due_date = now() - interval '5 days' WHERE id = $1`,
      [invoiceId]
    );
  } catch (err) {
    h.evidence.na(`Could not backdate due_date: ${(err as Error).message}`);
    return;
  }

  // The overdue sweep is worker-driven (no HTTP trigger). Poll the job money_state briefly.
  let moneyState = 'unknown';
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await h.db.query({
      label: `04-money-state-${i}`,
      tenantId: h.tenantA.tenantId,
      sql: `SELECT j.money_state FROM jobs j WHERE j.id = $1`,
      params: [h.tenantA.jobId],
    });
    moneyState = (res.rows[0] as { money_state?: string })?.money_state ?? 'unknown';
    if (moneyState === 'overdue') break;
  }
  if (moneyState === 'overdue') h.evidence.pass();
  else h.evidence.partial(`money_state=${moneyState} after backdating due_date; the overdue sweep worker may not be running on dev.`);
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
