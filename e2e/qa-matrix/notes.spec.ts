import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * NOTE-01 — note CRUD against the seeded job: create → list → edit → delete,
 *           verified through the API and the notes table.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('NOTE-01', 'Note CRUD on a job', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;

  const created = await h.api.call({
    method: 'POST',
    path: '/api/notes',
    body: { entityType: 'job', entityId: jobId, content: 'QA note v1' },
    token,
    label: '01-create',
    expectStatus: 201,
  });
  const noteId = (created.response.body as { id: string }).id;
  expect(noteId, 'note create must return an id').toBeTruthy();

  const list = await h.api.call({
    method: 'GET',
    path: `/api/notes?entityType=job&entityId=${jobId}`,
    token,
    label: '01-list',
    expectStatus: 200,
  });
  const listed = list.response.body as Array<{ id: string }> | { data?: Array<{ id: string }> };
  const items = Array.isArray(listed) ? listed : listed.data ?? [];
  expect(items.some((n) => n.id === noteId), 'created note must appear in the job notes list').toBe(true);

  await h.api.call({
    method: 'PUT',
    path: `/api/notes/${noteId}`,
    body: { content: 'QA note v2 (edited)' },
    token,
    label: '01-edit',
    expectStatus: 200,
  });
  const edited = await h.db.query({
    label: '01-edited-row',
    tenantId,
    sql: `SELECT content FROM notes WHERE id = $1`,
    params: [noteId],
  });
  expect((edited.rows[0] as { content: string }).content, 'edit must persist new content').toBe('QA note v2 (edited)');

  await h.api.call({
    method: 'DELETE',
    path: `/api/notes/${noteId}`,
    token,
    label: '01-delete',
    expectStatus: [200, 204],
  });
  const after = await h.db.query({
    label: '01-after-delete',
    tenantId,
    sql: `SELECT id FROM notes WHERE id = $1`,
    params: [noteId],
  });
  expect(after.rowCount, 'deleted note must be gone from the table').toBe(0);

  h.evidence.pass();
});
