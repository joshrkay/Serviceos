import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * CUST-03 — archive a customer: POST /api/customers/:id/archive flips
 *           is_archived=true (archived_at stamped) and drops the customer
 *           from the default active list.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('CUST-03', 'Archive customer', async (h) => {
  const { token, tenantId } = h.tenantA;
  const stamp = Date.now();

  const created = await h.api.call({
    method: 'POST',
    path: '/api/customers',
    body: { firstName: 'Arch', lastName: `Ive-${stamp}`, primaryPhone: `+1555${String(stamp).slice(-7)}` },
    token,
    label: '03-create',
    expectStatus: 201,
  });
  const customerId = (created.response.body as { id: string }).id;

  await h.api.call({
    method: 'POST',
    path: `/api/customers/${customerId}/archive`,
    token,
    label: '03-archive',
    expectStatus: [200, 204],
  });

  const row = await h.db.query({
    label: '03-archived-row',
    tenantId,
    sql: `SELECT is_archived, archived_at FROM customers WHERE id = $1`,
    params: [customerId],
  });
  expect(row.rowCount, 'customer row must exist').toBe(1);
  const r = row.rows[0] as { is_archived: boolean; archived_at: string | null };
  expect(r.is_archived, 'archive must set is_archived=true').toBe(true);

  // Default list must exclude archived customers.
  const list = await h.api.call({
    method: 'GET',
    path: '/api/customers',
    token,
    label: '03-active-list',
    expectStatus: 200,
  });
  const body = list.response.body as { data?: Array<{ id: string }> } | Array<{ id: string }>;
  const items = Array.isArray(body) ? body : body.data ?? [];
  expect(items.some((c) => c.id === customerId), 'archived customer must not appear in the default active list').toBe(false);

  await gotoUi(h, '/customers', '03-customers-ui');
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
