import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * SCH-04 — appointment status lifecycle via the REST API: an appointment is
 *          walked confirmed → in_progress → completed, each step persisted.
 * SCH-05 — the `running_late` virtual status enqueues a customer delay notice
 *          and intentionally does NOT change the stored status.
 */

test.describe.configure({ mode: 'serial' });

function futureWindow(daysOut: number): { scheduledStart: string; scheduledEnd: string } {
  const start = new Date(Date.now() + daysOut * 86_400_000);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

async function createAppointment(h: RowHarness, label: string): Promise<string> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/appointments',
    body: { jobId: h.tenantA.jobId, ...futureWindow(2), timezone: 'America/New_York', notes: 'QA lifecycle' },
    token: h.tenantA.token,
    label,
    expectStatus: 201,
  });
  return (res.response.body as { id: string }).id;
}

async function dbStatus(h: RowHarness, id: string, label: string): Promise<string> {
  const r = await h.db.query({
    label,
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM appointments WHERE id = $1`,
    params: [id],
  });
  return (r.rows[0] as { status: string }).status;
}

matrixTest('SCH-04', 'Appointment status lifecycle (confirm → in progress → complete)', async (h) => {
  const id = await createAppointment(h, '04-create');
  expect(await dbStatus(h, id, '04-status-initial'), 'new appointment starts scheduled').toBe('scheduled');

  for (const status of ['confirmed', 'in_progress', 'completed'] as const) {
    await h.api.call({
      method: 'PUT',
      path: `/api/appointments/${id}`,
      body: { status },
      token: h.tenantA.token,
      label: `04-${status}`,
      expectStatus: 200,
    });
    expect(await dbStatus(h, id, `04-db-${status}`), `status must persist as ${status}`).toBe(status);
  }

  h.evidence.pass();
});

matrixTest('SCH-05', 'Running-late delay notice (virtual status)', async (h) => {
  const id = await createAppointment(h, '05-create');
  await h.api.call({
    method: 'PUT',
    path: `/api/appointments/${id}`,
    body: { status: 'confirmed' },
    token: h.tenantA.token,
    label: '05-confirm',
    expectStatus: 200,
  });

  const late = await h.api.call({
    method: 'PUT',
    path: `/api/appointments/${id}`,
    body: { status: 'running_late', delayMinutes: 20 },
    token: h.tenantA.token,
    label: '05-running-late',
    expectStatus: 200,
  });
  expect((late.response.body as { queued?: boolean }).queued, 'running_late must report the delay notice was queued').toBe(true);

  expect(await dbStatus(h, id, '05-status-unchanged'), 'running_late is virtual — stored status stays confirmed').toBe('confirmed');

  h.evidence.pass();
});
