import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * TIME-01 — technician clock-in → clock-out. The owner token clocks itself in
 *           against the seeded job, then clocks out; the DB time_entries row
 *           records both timestamps under the tenant.
 */

test.describe.configure({ mode: 'serial' });

matrixTest('TIME-01', 'Technician clock-in → clock-out', async (h) => {
  const { token, tenantId, jobId } = h.tenantA;

  const clockIn = await h.api.call({
    method: 'POST',
    path: '/api/time-entries/clock-in',
    body: { entryType: 'job', jobId },
    token,
    label: '01-clock-in',
    expectStatus: 201,
  });
  const entryId = (clockIn.response.body as { id: string }).id;
  expect(entryId, 'clock-in must return an entry id').toBeTruthy();

  const open = await h.db.query({
    label: '01-row-open',
    tenantId,
    sql: `SELECT clocked_in_at, clocked_out_at FROM time_entries WHERE id = $1`,
    params: [entryId],
  });
  expect(open.rowCount, 'time entry row must exist').toBe(1);
  expect((open.rows[0] as { clocked_in_at: string | null }).clocked_in_at, 'clock-in stamps clocked_in_at').toBeTruthy();
  expect((open.rows[0] as { clocked_out_at: string | null }).clocked_out_at, 'open entry has no clocked_out_at yet').toBeNull();

  await h.api.call({
    method: 'POST',
    path: '/api/time-entries/clock-out',
    body: {},
    token,
    label: '01-clock-out',
    expectStatus: [200, 201],
  });

  const closed = await h.db.query({
    label: '01-row-closed',
    tenantId,
    sql: `SELECT clocked_out_at FROM time_entries WHERE id = $1`,
    params: [entryId],
  });
  expect((closed.rows[0] as { clocked_out_at: string | null }).clocked_out_at, 'clock-out stamps clocked_out_at').toBeTruthy();

  h.evidence.pass();
});
