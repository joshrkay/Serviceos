import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * CAT-01 — catalog (price-book) item CRUD: create → appears in list →
 *          update price → delete (drops from the active list).
 */

test.describe.configure({ mode: 'serial' });

async function listIds(h: RowHarness, label: string): Promise<string[]> {
  const res = await h.api.call({ method: 'GET', path: '/api/catalog/items', token: h.tenantA.token, label, expectStatus: 200 });
  const body = res.response.body as Array<{ id: string }> | { data?: Array<{ id: string }>; items?: Array<{ id: string }> };
  const arr = Array.isArray(body) ? body : body.data ?? body.items ?? [];
  return arr.map((i) => i.id);
}

matrixTest('CAT-01', 'Catalog item CRUD', async (h) => {
  const { token } = h.tenantA;

  const created = await h.api.call({
    method: 'POST',
    path: '/api/catalog/items',
    body: { name: `QA Diagnostic ${Date.now()}`, category: 'Labor', unit: 'hour', unitPriceCents: 12_500 },
    token,
    label: '01-create',
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  expect(id, 'catalog item create must return an id').toBeTruthy();
  expect(await listIds(h, '01-list'), 'new item must appear in the active list').toContain(id);

  await h.api.call({
    method: 'PUT',
    path: `/api/catalog/items/${id}`,
    body: { unitPriceCents: 15_000 },
    token,
    label: '01-update',
    expectStatus: 200,
  });
  const updated = await h.db.query({
    label: '01-updated-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT unit_price_cents FROM catalog_items WHERE id = $1`,
    params: [id],
  });
  expect(Number((updated.rows[0] as { unit_price_cents: number }).unit_price_cents), 'price update must persist').toBe(15_000);

  await h.api.call({
    method: 'DELETE',
    path: `/api/catalog/items/${id}`,
    token,
    label: '01-delete',
    expectStatus: [200, 204],
  });
  expect(await listIds(h, '01-list-after'), 'deleted item must drop from the active list').not.toContain(id);

  h.evidence.pass();
});
