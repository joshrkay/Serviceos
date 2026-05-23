import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * PORT-01 — customer-facing public estimate approval via the view token.
 * PORT-02 — public invoice view + checkout via the view token.
 * Public routes are mounted before auth, so they take no bearer token — the
 * token IS the auth. Token is obtained from the /send response (or the
 * view_token column as a fallback).
 */

test.describe.configure({ mode: 'serial' });

const LINE = [
  { id: 'li-1', description: 'Service', category: 'labor', quantity: 1, unitPriceCents: 18000, totalCents: 18000, sortOrder: 0, taxable: false },
];

async function readToken(
  h: RowHarness,
  table: 'estimates' | 'invoices',
  id: string
): Promise<string | undefined> {
  const db = await h.db.query({
    label: `${table}-view-token`,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT view_token FROM ${table} WHERE id = $1`,
    params: [id],
  });
  return (db.rows[0] as { view_token?: string })?.view_token ?? undefined;
}

matrixTest('PORT-01', 'Public estimate approval via view token', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: { jobId: h.tenantA.jobId, lineItems: LINE, discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label: '01-create',
    expectStatus: 201,
  });
  const estimateId = (created.response.body as { id: string }).id;

  const send = await h.api.call({
    method: 'POST',
    path: `/api/estimates/${estimateId}/send`,
    body: { channel: 'sms', recipientPhone: '+15555550111' },
    token: h.tenantA.token,
    label: '01-send',
    expectStatus: [200, 202, 400, 503],
  });
  const token =
    (send.response.body as { viewToken?: string }).viewToken ?? (await readToken(h, 'estimates', estimateId));

  if (!token) {
    h.evidence.partial('No public view token (send service likely unwired on dev); cannot exercise the public estimate page.');
    return;
  }

  // Negative tokens.
  await h.api.call({ method: 'GET', path: '/public/estimates/short', label: '01-neg-short', expectStatus: [400, 404] });
  await h.api.call({
    method: 'GET',
    path: '/public/estimates/0000000000000000000000000000000000000000',
    label: '01-neg-missing',
    expectStatus: 404,
  });

  // Valid public fetch (no auth) + approve.
  const pub = await h.api.call({
    method: 'GET',
    path: `/public/estimates/${token}`,
    label: '01-public-get',
    expectStatus: 200,
  });
  expect(pub.response.status).toBe(200);

  const approve = await h.api.call({
    method: 'POST',
    path: `/public/estimates/${token}/approve`,
    body: { acceptedByName: 'QA Approver' },
    label: '01-approve',
    expectStatus: [200, 409],
  });

  const db = await h.db.query({
    label: '01-status',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM estimates WHERE id = $1`,
    params: [estimateId],
  });
  const status = (db.rows[0] as { status: string }).status;

  await gotoUi(h, `/e/${token}`, '01-public-ui');

  if (approve.response.status === 200 && status === 'accepted') h.evidence.pass();
  else h.evidence.partial(`Public fetch ok; approve status=${approve.response.status}, estimate status=${status}.`);
});

matrixTest('PORT-02', 'Public invoice view + checkout via view token', async (h) => {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/invoices',
    body: { jobId: h.tenantA.jobId, lineItems: LINE, discountCents: 0, taxRateBps: 0 },
    token: h.tenantA.token,
    label: '02-create',
    expectStatus: 201,
  });
  const invoiceId = (created.response.body as { id: string }).id;

  await h.api.call({
    method: 'POST',
    path: `/api/invoices/${invoiceId}/issue`,
    body: { paymentTermDays: 30 },
    token: h.tenantA.token,
    label: '02-issue',
    expectStatus: [200, 400],
  });

  const send = await h.api.call({
    method: 'POST',
    path: `/api/invoices/${invoiceId}/send`,
    body: { channel: 'sms', recipientPhone: '+15555550112' },
    token: h.tenantA.token,
    label: '02-send',
    expectStatus: [200, 202, 400, 503],
  });
  const token =
    (send.response.body as { viewToken?: string }).viewToken ?? (await readToken(h, 'invoices', invoiceId));

  if (!token) {
    h.evidence.partial('No public view token (send service likely unwired on dev); cannot exercise the public invoice page.');
    return;
  }

  await h.api.call({ method: 'GET', path: '/public/invoices/short', label: '02-neg-short', expectStatus: [400, 404] });
  await h.api.call({
    method: 'GET',
    path: '/public/invoices/0000000000000000000000000000000000000000',
    label: '02-neg-missing',
    expectStatus: [400, 404],
  });

  const pub = await h.api.call({
    method: 'GET',
    path: `/public/invoices/${token}`,
    label: '02-public-get',
    expectStatus: 200,
  });
  expect(pub.response.status).toBe(200);

  const checkout = await h.api.call({
    method: 'POST',
    path: `/public/invoices/${token}/checkout`,
    body: {},
    label: '02-checkout',
    expectStatus: [200, 400, 404],
  });

  await gotoUi(h, `/pay/${token}`, '02-public-ui');

  if (checkout.response.status === 200 && (checkout.response.body as { url?: string }).url) {
    h.evidence.pass('Public invoice view + Stripe checkout link returned.');
  } else {
    h.evidence.partial(`Public invoice view ok; checkout status=${checkout.response.status} (Stripe may be unconfigured on dev).`);
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
  await h.page.waitForTimeout(500);
  await h.snapshot(label);
}
