import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';
import { startVoiceSession, voiceInput, approveAndAwaitExecution } from './helpers/voice-flow';

/**
 * SCH-01 — create + reschedule an appointment via the REST API (deterministic).
 * SCH-02 — schedule an appointment by voice (inbound) → create_appointment proposal.
 * SCH-03 — cancel an appointment by voice → cancel_appointment proposal (no REST cancel).
 *          Runs against tenant B so the tenant has exactly one upcoming
 *          appointment and the resolution is genuinely unambiguous — see the
 *          comment on the row itself.
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

async function createAppointment(
  h: RowHarness,
  label: string,
  tenant: RowHarness['tenantA'] = h.tenantA,
): Promise<{ id: string; version: number }> {
  const win = futureWindow(2);
  const res = await h.api.call({
    method: 'POST',
    path: '/api/appointments',
    body: { jobId: tenant.jobId, ...win, timezone: 'America/New_York', notes: 'QA scheduling' },
    token: tenant.token,
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
  // QA-2026-07-26 — pass the seeded customer's phone (fixtures/seed.ts:
  // '555-0100', unique per tenant) as callerPhone so InAppVoiceAdapter
  // resolves the caller identity up front via findByPhoneNormalized. Without
  // this, the generic "our customer" phrase below has no name to fall back
  // on and never resolves (GENERIC_CUSTOMER_REFS skips name-based lookup).
  const sessionId = await startVoiceSession(h, token, '02', '555-0100');
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
    return void h.evidence.fail(`Scheduling proposal did not execute (status=${outcome.status}); worker/entity-resolution may be incomplete.`);
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
  // QA-2026-07-27 (SCH-03) — this row runs against TENANT B, not tenant A.
  //
  // passCriteria: "Voice cancel utterance → cancel_appointment proposal →
  // approve → executed; appointment status=canceled". To test that, the
  // utterance has to name an appointment the resolver can actually land on.
  //
  // Two things were wrong with the old shape:
  //  1. It spoke the pronoun "that job" with NO antecedent anywhere in the
  //     session — the seed appointment is created over REST, outside the
  //     voice call, so nothing in the transcript ever introduced a job. The
  //     row was asserting a coreference the caller never established.
  //  2. It passed no callerPhone, unlike SCH-02 (:76, '555-0100'), so the
  //     adapter never resolved a caller identity up front.
  //
  // Tenant A accumulates upcoming appointments across the matrix (SCH-01,
  // SCH-02, SCH-04, SCH-05, PROP-*, SMS-*), so a tenant-scoped "the upcoming
  // appointment" lookup there is legitimately AMBIGUOUS and the honest
  // product answer is a disambiguation question — which is not what this row
  // is measuring. Tenant B is seeded identically (customer '555-0100', one
  // open job, plumbing pack — fixtures/seed.ts) and NO other row creates an
  // appointment for it, and `npm run qa:reset` wipes every tenant-scoped
  // table before the run. So tenant B has exactly ONE upcoming appointment
  // here: the one seeded on the line below. That makes the row deterministic
  // AND makes it exercise the real single-match resolution path rather than
  // asserting around it.
  const { token, tenantId } = h.tenantB;

  // Something to cancel — the only upcoming appointment this tenant has.
  const appt = await createAppointment(h, '03-seed-appt', h.tenantB);

  // Guard the premise instead of assuming it: if this tenant somehow has more
  // than one upcoming appointment, the row's own assertion is meaningless and
  // we say so rather than reporting a resolution failure that isn't one.
  const upcoming = await h.db.query({
    label: '03-upcoming-precondition',
    tenantId,
    sql: `SELECT id FROM appointments
           WHERE tenant_id = $1 AND status <> 'canceled' AND scheduled_start >= now()`,
    params: [tenantId],
  });
  if (upcoming.rowCount !== 1) {
    return void h.evidence.fail(
      `Precondition broken: tenant B has ${upcoming.rowCount} upcoming appointments, expected exactly 1. ` +
        'Run `npm run qa:reset && npm run qa:setup` before the matrix.'
    );
  }

  const sessionId = await startVoiceSession(h, token, '03', '555-0100');
  if (!sessionId) return void h.evidence.fail('Voice session could not be started.');

  const proposalIds = await voiceInput(
    h,
    token,
    sessionId,
    'Cancel my upcoming appointment please — I need to reschedule it for a later date',
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
    h.evidence.fail(
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
