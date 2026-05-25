import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * MC-01 — create a maintenance contract and read it back. The contract store
 *          is currently in-process, but every mutation emits an audit event,
 *          so we verify the create via the API (create → get → list) and the
 *          maintenance_contract.created audit row in the DB.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('MC-01', 'Create + read a maintenance contract', async (h) => {
  const { token, tenantId } = h.tenantA;

  const created = await h.api.call({
    method: 'POST',
    path: '/api/maintenance-contracts',
    body: { title: 'QA Quarterly HVAC', cadence: 'quarterly', customer: 'QA Customer', startDate: '2026-06-01' },
    token,
    label: '01-create',
    expectStatus: 201,
  });
  const contract = created.response.body as { id: string; status: string; title: string };
  expect(contract.id, 'contract create must return an id').toBeTruthy();
  expect(contract.status, 'a new contract is active').toBe('active');

  const fetched = await h.api.call({
    method: 'GET',
    path: `/api/maintenance-contracts/${contract.id}`,
    token,
    label: '01-get',
    expectStatus: 200,
  });
  expect((fetched.response.body as { title: string }).title, 'fetched contract must echo the title').toBe('QA Quarterly HVAC');

  const list = await h.api.call({
    method: 'GET',
    path: '/api/maintenance-contracts',
    token,
    label: '01-list',
    expectStatus: 200,
  });
  const body = list.response.body as Array<{ id: string }> | { data?: Array<{ id: string }> };
  const items = Array.isArray(body) ? body : body.data ?? [];
  expect(items.some((c) => c.id === contract.id), 'created contract must appear in the list').toBe(true);

  const audit = await h.db.query({
    label: '01-audit',
    tenantId,
    sql: `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'maintenance_contract.created'`,
    params: [tenantId, contract.id],
  });
  expect(audit.rowCount, 'create must emit a maintenance_contract.created audit event').toBeGreaterThanOrEqual(1);

  h.evidence.pass();
});
