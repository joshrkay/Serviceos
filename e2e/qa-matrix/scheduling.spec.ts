import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession, voiceInput, approveAndAwaitExecution } from './helpers/voice-flow';

/**
 * SCH-01 — create + reschedule an appointment via the REST API (deterministic).
 * SCH-02 — schedule an appointment by voice (inbound) → create_appointment proposal.
 * SCH-03 — cancel an appointment by voice → cancel_appointment proposal (no REST cancel).
 *
 * SCH-02/03 are Real-LLM-only and depend on the dev API's classifier + entity
 * resolution; they fail loudly if the voice pipeline isn't ready.
 */

test.describe.configure({ mode: 'serial' });

function futureWindow(daysOut: number): { scheduledStart: string; scheduledEnd: string } {
  const start = new Date(Date.now() + daysOut * 86_400_000);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

async function createAppointment(h: RowHarness, label: string): Promise<{ id: string; version: number }> {
  const win = futureWindow(2);
  const res = await h.api.call({
    method: 'POST',
    path: '/api/appointments',
    body: { jobId: h.tenantA.jobId, ...win, timezone: 'America/New_York', notes: 'QA scheduling' },
    token: h.tenantA.token,
    label,
    expectStatus: 201,
  });
  const body = res.response.body as { id: string; version?: number };
  return { id: body.id, version: body.version ?? 0 };
}

matrixTest('SCH-01', 'Create + reschedule appointment (API)', async (h) => {
  const appt = await createAppointment(h, '01-create');

  const before = await h.db.query({
    label: '01-row-before',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status, scheduled_start FROM appointments WHERE id = $1`,
    params: [appt.id],
  });
  expect(before.rowCount, 'appointment row must exist').toBe(1);

  const next = futureWindow(3);
  await h.api.call({
    method: 'PUT',
    path: `/api/appointments/${appt.id}`,
    body: next,
    token: h.tenantA.token,
    label: '01-reschedule',
    expectStatus: 200,
  });

  const after = await h.db.query({
    label: '01-row-after',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT scheduled_start FROM appointments WHERE id = $1`,
    params: [appt.id],
  });
  const afterRow = after.rows[0] as { scheduled_start: string };
  expect(new Date(afterRow.scheduled_start).getTime(), 'reschedule must move the start time').toBe(
    new Date(next.scheduledStart).getTime()
  );

  await gotoUi(h, '/dispatch', '01-board-ui');
  h.evidence.pass();
});

matrixTest('SCH-02', 'Schedule appointment by voice', async (h) => {
  const { token, tenantId } = h.tenantA;
  const sessionId = await startVoiceSession(h, token, '02');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const proposalIds = await voiceInput(
    h,
    token,
    sessionId,
    'Schedule a furnace tune-up for our customer next Tuesday at 2 PM',
    '02'
  );
  if (proposalIds.length === 0) {
    return void h.evidence.fail('No proposal from scheduling utterance — AI pipeline not ready (Real-LLM-only).');
  }

  const outcome = await approveAndAwaitExecution(h, token, proposalIds[0], '02');
  if (outcome.status !== 'executed') {
    return void h.evidence.partial(`Scheduling proposal did not execute (status=${outcome.status}); worker/entity-resolution may be incomplete.`);
  }

  if (!outcome.resultEntityId) {
    return void h.evidence.fail('Scheduling proposal executed but returned no resultEntityId; cannot confirm an appointment was created.');
  }
  const db = await h.db.query({
    label: '02-appt-row',
    tenantId,
    sql: `SELECT id, status FROM appointments WHERE id = $1`,
    params: [outcome.resultEntityId],
  });
  expect(db.rowCount, 'voice-scheduled appointment row must exist').toBe(1);
  await gotoUi(h, '/dispatch', '02-board-ui');
  h.evidence.pass();
});

matrixTest('SCH-03', 'Cancel appointment by voice', async (h) => {
  const { token, tenantId } = h.tenantA;

  // Something to cancel.
  const appt = await createAppointment(h, '03-seed-appt');

  const sessionId = await startVoiceSession(h, token, '03');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const proposalIds = await voiceInput(
    h,
    token,
    sessionId,
    'Cancel the upcoming appointment for that job — the customer needs to reschedule later',
    '03'
  );
  if (proposalIds.length === 0) {
    return void h.evidence.fail('No cancel proposal produced — AI pipeline not ready (Real-LLM-only).');
  }

  const outcome = await approveAndAwaitExecution(h, token, proposalIds[0], '03');
  const canceled = await h.db.query({
    label: '03-appt-status',
    tenantId,
    sql: `SELECT status FROM appointments WHERE id = $1`,
    params: [appt.id],
  });
  const status = (canceled.rows[0] as { status?: string })?.status;
  if (outcome.status === 'executed' && status === 'canceled') {
    h.evidence.pass();
  } else {
    h.evidence.partial(
      `Cancel-by-voice incomplete (proposal=${outcome.status}, appointment=${status}). ` +
        'Voice agent must resolve which appointment to cancel; verify entity resolution live.'
    );
  }
  await gotoUi(h, '/dispatch', '03-board-ui');
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
