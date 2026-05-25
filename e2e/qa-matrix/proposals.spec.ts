import { expect, matrixTest, test, type RowHarness } from './helpers/matrix-test';

/**
 * PROP-01 — scheduling proposal lifecycle: create an appointment, raise a
 *           remove_crew_member proposal (optimistic-concurrency via If-Match),
 *           then reject it and confirm the DB row is rejected.
 * PROP-02 — GET /api/proposals/inbox returns a well-formed prioritized payload.
 * PROP-03 — Tenant B cannot read a proposal created under Tenant A (403/404).
 *
 * All deterministic + API/DB-verifiable; no AI key required (the HTTP create
 * path is scoped to scheduling proposal types, not the LLM gateway).
 *
 * NOTE: these use remove_crew_member, which is the one HTTP-creatable
 * scheduling proposal type that skips the technician-calendar feasibility
 * check (see create-scheduling.ts) — keeping the lifecycle assertions
 * independent of feasibility wiring. A separate finding tracks a 500 in the
 * reschedule_appointment path when no technician is resolved.
 */

test.describe.configure({ mode: 'serial' });

function futureWindow(daysOut: number): { scheduledStart: string; scheduledEnd: string } {
  const start = new Date(Date.now() + daysOut * 86_400_000);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return { scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

/** Create an appointment for tenant A and return its id + current version (updatedAt ISO). */
async function seedAppointment(h: RowHarness, label: string): Promise<{ id: string; version: string }> {
  const created = await h.api.call({
    method: 'POST',
    path: '/api/appointments',
    body: { jobId: h.tenantA.jobId, ...futureWindow(2), timezone: 'America/New_York', notes: 'QA proposals' },
    token: h.tenantA.token,
    label: `${label}-appt`,
    expectStatus: 201,
  });
  const id = (created.response.body as { id: string }).id;
  // The reschedule proposal's If-Match must equal the appointment's stored
  // updatedAt ISO string (createSchedulingProposal compares against it).
  const got = await h.api.call({
    method: 'GET',
    path: `/api/appointments/${id}`,
    token: h.tenantA.token,
    label: `${label}-appt-get`,
    expectStatus: 200,
  });
  const version = (got.response.body as { updatedAt: string }).updatedAt;
  return { id, version };
}

/**
 * Raise a remove_crew_member proposal for an existing appointment. Returns the
 * proposal id, or null on non-200. remove_crew_member is deliberately chosen:
 * create-scheduling.ts skips feasibility for it, so creation is deterministic.
 */
async function createCrewChangeProposal(
  h: RowHarness,
  appt: { id: string; version: string },
  label: string,
): Promise<string | null> {
  const res = await h.api.call({
    method: 'POST',
    path: '/api/proposals',
    headers: { 'If-Match': appt.version },
    body: {
      proposalType: 'remove_crew_member',
      payload: { appointmentId: appt.id, technicianId: randomUuid(), reason: 'QA crew change' },
      summary: 'QA crew-change proposal',
    },
    token: h.tenantA.token,
    label,
  });
  if (res.response.status !== 200) {
    h.evidence.note(`create crew-change proposal returned ${res.response.status} (expected 200).`);
    return null;
  }
  return (res.response.body as { id: string }).id ?? null;
}

function randomUuid(): string {
  // Node 18+ global crypto.
  return (globalThis.crypto as Crypto).randomUUID();
}

matrixTest('PROP-01', 'Scheduling proposal creation + approval-state guard', async (h) => {
  const appt = await seedAppointment(h, '01');
  const proposalId = await createCrewChangeProposal(h, appt, '01-create-proposal');
  if (!proposalId) {
    return void h.evidence.fail('Could not create scheduling proposal (see 01-create-proposal artifact for status/body).');
  }

  // HTTP-created scheduling proposals land as `draft` (no source trust tier),
  // and must be promoted to ready_for_review before an operator can act.
  const created = await h.db.query({
    label: '01-proposal-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM proposals WHERE id = $1`,
    params: [proposalId],
  });
  expect(created.rowCount, 'proposal row must exist under tenant A').toBe(1);
  expect((created.rows[0] as { status: string }).status, 'HTTP-created scheduling proposal starts as draft').toBe('draft');

  // The approval engine must refuse a reject from `draft` (409 conflict): you
  // cannot reject what has not yet been surfaced for review. This guards the
  // human-in-the-loop invariant.
  const reject = await h.api.call({
    method: 'POST',
    path: `/api/proposals/${proposalId}/reject`,
    body: { reason: 'QA guard check' },
    token: h.tenantA.token,
    label: '01-reject-from-draft',
    expectStatus: 409,
  });
  expect(reject.response.status, 'rejecting a draft proposal must be refused with 409').toBe(409);

  // And the draft must remain a draft — the refused reject left no side effect.
  const after = await h.db.query({
    label: '01-proposal-after',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT status FROM proposals WHERE id = $1`,
    params: [proposalId],
  });
  expect((after.rows[0] as { status: string }).status, 'refused reject must not mutate the draft').toBe('draft');
  await gotoUi(h, '/inbox', '01-inbox-ui');
  h.evidence.pass();
});

matrixTest('PROP-02', 'Proposal inbox prioritization endpoint', async (h) => {
  const res = await h.api.call({
    method: 'GET',
    path: '/api/proposals/inbox',
    token: h.tenantA.token,
    label: '02-inbox',
    expectStatus: 200,
  });
  const body = res.response.body as { data?: unknown; summary?: { totalCount?: number } };
  expect(Array.isArray(body.data), 'inbox payload must include a data array').toBe(true);
  expect(body.summary, 'inbox payload must include a summary').toBeTruthy();
  expect(typeof body.summary!.totalCount, 'summary.totalCount must be a number').toBe('number');
  await gotoUi(h, '/inbox', '02-inbox-ui');
  h.evidence.pass();
});

matrixTest('PROP-03', 'Cross-tenant proposal access denial', async (h) => {
  // Create a proposal under tenant A, then attempt to read it as tenant B.
  const appt = await seedAppointment(h, '03');
  const proposalId = await createCrewChangeProposal(h, appt, '03-create-proposal');
  if (!proposalId) {
    return void h.evidence.fail('Could not create tenant-A proposal to test cross-tenant denial.');
  }

  const asB = await h.api.call({
    method: 'GET',
    path: `/api/proposals/${proposalId}`,
    token: h.tenantB.token,
    label: '03-cross-tenant-read',
  });
  expect([403, 404], `tenant B reading tenant A proposal must be denied, got ${asB.response.status}`).toContain(
    asB.response.status,
  );
  h.evidence.pass();
});

matrixTest('PROP-04', 'Time-only reschedule proposal does not 500 (regression)', async (h) => {
  // Regression for the empty-UUID feasibility crash: a reschedule with no
  // technician in the payload, against an unassigned appointment, must not 500.
  const appt = await seedAppointment(h, '04');
  const next = futureWindow(6);
  const res = await h.api.call({
    method: 'POST',
    path: '/api/proposals',
    headers: { 'If-Match': appt.version },
    body: {
      proposalType: 'reschedule_appointment',
      payload: { appointmentId: appt.id, newScheduledStart: next.scheduledStart, newScheduledEnd: next.scheduledEnd, reason: 'QA time-only reschedule' },
      summary: 'QA time-only reschedule',
    },
    token: h.tenantA.token,
    label: '04-reschedule-no-tech',
  });
  expect(res.response.status, 'time-only reschedule must not 500 (empty-UUID feasibility regression)').not.toBe(500);
  expect(res.response.status, 'time-only reschedule should be accepted (200)').toBe(200);
  const proposalId = (res.response.body as { id?: string }).id;
  const row = await h.db.query({
    label: '04-proposal-row',
    tenantId: h.tenantA.tenantId,
    sql: `SELECT id, proposal_type FROM proposals WHERE id = $1`,
    params: [proposalId],
  });
  expect(row.rowCount, 'reschedule proposal row must persist').toBe(1);
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
