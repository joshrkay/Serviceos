import { expect, matrixTest, test } from './helpers/matrix-test';

/**
 * EST-R1 — revise a SENT estimate. A draft is created, transitioned to sent,
 *          then revised with an If-Match version guard. The revision bumps
 *          the version, stamps last_revised_at, and snapshots the prior
 *          version into document_revisions.
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

matrixTest('EST-R1', 'Revise a sent estimate (versioned snapshot)', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;

  const created = await h.api.call({
    method: 'POST',
    path: '/api/estimates',
    body: { jobId, lineItems: [lineItem('li-1', 'Diagnostic', 12_500)] },
    token,
    label: '01-create',
    expectStatus: 201,
  });
  const estimateId = (created.response.body as { id: string }).id;
  const version = (created.response.body as { version: number }).version;
  expect(estimateId, 'estimate create must return an id').toBeTruthy();
  expect(version, 'a new estimate starts at version 1').toBe(1);

  await h.api.call({
    method: 'POST',
    path: `/api/estimates/${estimateId}/transition`,
    body: { status: 'sent' },
    token,
    label: '02-send',
    expectStatus: 200,
  });

  await h.api.call({
    method: 'POST',
    path: `/api/estimates/${estimateId}/revise`,
    body: { lineItems: [lineItem('li-1', 'Diagnostic', 12_500), lineItem('li-2', 'Added part', 40_000)] },
    token,
    label: '03-revise',
    headers: { 'If-Match': String(version) },
    expectStatus: 200,
  });

  const estRow = await h.db.query({
    label: '03-estimate-row',
    tenantId,
    sql: `SELECT version, last_revised_at FROM estimates WHERE id = $1`,
    params: [estimateId],
  });
  expect(Number((estRow.rows[0] as { version: number }).version), 'revise must bump the version to 2').toBe(2);
  expect((estRow.rows[0] as { last_revised_at: string | null }).last_revised_at, 'revise must stamp last_revised_at').not.toBeNull();

  const revisions = await h.db.query({
    label: '03-revision-snapshot',
    tenantId,
    sql: `SELECT version FROM document_revisions WHERE document_type = 'estimate' AND document_id = $1`,
    params: [estimateId],
  });
  expect(revisions.rowCount, 'revise must snapshot the prior version into document_revisions').toBeGreaterThanOrEqual(1);

  h.evidence.pass();
});
